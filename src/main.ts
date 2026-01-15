import { App, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";
import { ObsidianMcpHost, McpConfig } from "./mcp/host";
import { VectorIndexer } from "./vector/indexer";
import { VectorSearchSettings, DEFAULT_VECTOR_SETTINGS } from "./vector/types";

interface F9ObsidianMCPSettings {
  mcpEnabled: boolean;
  mcpPort: number;
  mcpDnsRebindingProtection: boolean;
  mcpHttpsEnabled: boolean;
  mcpTlsCert: string;
  mcpTlsKey: string;
  mcpSessionTimeoutMinutes: number;
  vectorSearch: VectorSearchSettings;
}

/**
 * Storage format for plugin data.
 * Settings are keyed by vault name to support multiple vaults sharing the same plugin folder.
 */
interface PluginData {
  vaults: Record<string, F9ObsidianMCPSettings>;
}

const DEFAULT_SETTINGS: F9ObsidianMCPSettings = {
  mcpEnabled: false,
  mcpPort: 3030,
  mcpDnsRebindingProtection: true,
  mcpHttpsEnabled: false,
  mcpTlsCert: "",
  mcpTlsKey: "",
  mcpSessionTimeoutMinutes: 30,
  vectorSearch: DEFAULT_VECTOR_SETTINGS,
};

const MCP_RESTART_DEBOUNCE_MS = 2000;

export default class F9ObsidianMCPPlugin extends Plugin {
  settings!: F9ObsidianMCPSettings;
  private mcpHost?: ObsidianMcpHost;
  vectorIndexer?: VectorIndexer;
  private statusBarItem?: HTMLElement;
  private mcpRestartTimer?: ReturnType<typeof setTimeout>;

  async onload() {
    console.log("Loading plugin: F9 Obsidian MCP");
    await this.loadSettings();

    // Initialize vector indexer
    this.vectorIndexer = new VectorIndexer(
      this.app,
      this,
      this.settings.vectorSearch
    );
    await this.vectorIndexer.loadIndex();

    // Register vault event handlers for auto-indexing
    if (this.settings.vectorSearch.autoIndex) {
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (file instanceof TFile && file.extension === "md") {
            this.vectorIndexer?.queueFileForIndexing(file.path);
          }
        })
      );

      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (file instanceof TFile && file.extension === "md") {
            this.vectorIndexer?.queueFileForIndexing(file.path);
          }
        })
      );

      this.registerEvent(
        this.app.vault.on("delete", (file) => {
          if (file instanceof TFile) {
            this.vectorIndexer?.handleFileDelete(file.path);
          }
        })
      );

      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          if (file instanceof TFile) {
            this.vectorIndexer?.handleFileRename(oldPath, file.path);
          }
        })
      );

      // Check for stale files on startup (after a brief delay)
      setTimeout(() => {
        this.vectorIndexer?.checkForStaleFiles();
      }, 2000);
    }

    const ribbon = this.addRibbonIcon(
      "dice",
      "F9 Obsidian MCP",
      () => {
        new Notice("F9 Obsidian MCP: Hello from your plugin!");
      }
    );
    ribbon.addClass("f9-obsidian-mcp-ribbon-icon");

    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar();

    // Update status bar every 2 seconds
    this.registerInterval(
      window.setInterval(() => this.updateStatusBar(), 2000)
    );

    this.addCommand({
      id: "f9-obsidian-mcp-say-hello",
      name: "Say Hello",
      callback: () => new Notice("F9 MCP says hello 👋"),
    });

    this.addSettingTab(new F9ObsidianMCPSettingTab(this.app, this));

    // Start MCP server if enabled
    await this.ensureMcpRunning();
  }

  onunload() {
    console.log("Unloading plugin: F9 Obsidian MCP");
    if (this.mcpRestartTimer) {
      clearTimeout(this.mcpRestartTimer);
      this.mcpRestartTimer = undefined;
    }
  }

  /**
   * Get the current vault's name for use as a settings key.
   */
  private getVaultKey(): string {
    return this.app.vault.getName();
  }

  async loadSettings() {
    const rawData = await this.loadData();
    const vaultKey = this.getVaultKey();

    // Check if data is in new format (has 'vaults' key)
    if (rawData && typeof rawData === "object" && "vaults" in rawData) {
      const pluginData = rawData as PluginData;
      this.settings = { ...DEFAULT_SETTINGS, ...pluginData.vaults[vaultKey] };
    } else if (rawData && typeof rawData === "object") {
      // Migrate from old format: existing settings become this vault's settings
      const oldSettings = rawData as Partial<F9ObsidianMCPSettings>;
      this.settings = { ...DEFAULT_SETTINGS, ...oldSettings };
      // Save in new format immediately to complete migration
      await this.saveSettings();
      console.log(`[F9 MCP] Migrated settings to vault-keyed format for: ${vaultKey}`);
    } else {
      this.settings = { ...DEFAULT_SETTINGS };
    }
  }

  async saveSettings() {
    const vaultKey = this.getVaultKey();
    const rawData = await this.loadData();

    // Load existing plugin data or create new structure
    let pluginData: PluginData;
    if (rawData && typeof rawData === "object" && "vaults" in rawData) {
      pluginData = rawData as PluginData;
    } else {
      pluginData = { vaults: {} };
    }

    // Save this vault's settings
    pluginData.vaults[vaultKey] = this.settings;
    await this.saveData(pluginData);
    this.scheduleMcpRestart();
  }

  /**
   * Schedule an MCP server restart with debouncing.
   * Multiple rapid config changes will only trigger one restart after the debounce period.
   */
  private scheduleMcpRestart(): void {
    if (this.mcpRestartTimer) {
      clearTimeout(this.mcpRestartTimer);
    }
    this.mcpRestartTimer = setTimeout(() => {
      this.mcpRestartTimer = undefined;
      this.ensureMcpRunning().catch((err) => {
        console.error("[F9 MCP] Error during scheduled restart:", err);
      });
    }, MCP_RESTART_DEBOUNCE_MS);
  }

  private async ensureMcpRunning() {
    const cfg: McpConfig = {
      enabled: this.settings.mcpEnabled,
      port: this.settings.mcpPort,
      allowedHosts: [
        `localhost:${this.settings.mcpPort}`,
        `127.0.0.1:${this.settings.mcpPort}`,
      ],
      enableDnsRebindingProtection: this.settings.mcpDnsRebindingProtection,
      https: this.settings.mcpHttpsEnabled,
      tls: this.settings.mcpHttpsEnabled
        ? {
            cert: this.settings.mcpTlsCert,
            key: this.settings.mcpTlsKey,
          }
        : undefined,
      sessionTimeoutMinutes: this.settings.mcpSessionTimeoutMinutes,
    };

    this.mcpHost ??= new ObsidianMcpHost(this.app, cfg, this.vectorIndexer);

    // Restart with latest config
    if (cfg.enabled) {
      try {
        await this.mcpHost.restart(cfg);
        const protocol = cfg.https ? "https" : "http";
        console.log(
          `F9 Obsidian MCP server listening on ${protocol}://127.0.0.1:${cfg.port}/mcp`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`F9 Obsidian MCP: Failed to start server: ${message}`);
        new Notice(`MCP Server Error: ${message}`);
      }
    } else {
      await this.mcpHost.stop();
    }
  }

  private updateStatusBar(): void {
    if (!this.statusBarItem) return;

    const parts: string[] = [`F9 MCP:${this.settings.mcpPort}`];

    // Add session count if MCP is running
    if (this.mcpHost?.isRunning()) {
      const sessionCount = this.mcpHost.getSessionCount();
      parts.push(`${sessionCount} session${sessionCount !== 1 ? "s" : ""}`);
    } else if (this.settings.mcpEnabled) {
      parts.push("starting...");
    } else {
      parts.push("off");
    }

    // Add indexing status
    if (this.vectorIndexer) {
      const indexStatus = this.vectorIndexer.getIndexingStatus();
      if (indexStatus.isIndexing) {
        parts.push("indexing...");
      } else if (indexStatus.pendingCount > 0) {
        parts.push(`${indexStatus.pendingCount} pending`);
      }
    }

    this.statusBarItem.setText(parts.join(" | "));
  }
}

class F9ObsidianMCPSettingTab extends PluginSettingTab {
  plugin: F9ObsidianMCPPlugin;

  constructor(app: App, plugin: F9ObsidianMCPPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "F9 Obsidian MCP Settings" });

    new Setting(containerEl)
      .setName("Enable MCP server")
      .setDesc("Host an MCP server inside Obsidian on 127.0.0.1")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.mcpEnabled)
          .onChange(async (value) => {
            this.plugin.settings.mcpEnabled = value;
            await this.plugin.saveSettings();
            this.display(); // Refresh to show/hide conditional settings
          })
      );

    new Setting(containerEl)
      .setName("MCP port")
      .setDesc("Local port for the MCP endpoint")
      .addText((text) =>
        text
          .setPlaceholder("3030")
          .setValue(String(this.plugin.settings.mcpPort))
          .onChange(async (val) => {
            const parsed = Number(val);
            if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) {
              this.plugin.settings.mcpPort = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("DNS rebinding protection")
      .setDesc("Validate Host header for local requests")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.mcpDnsRebindingProtection)
          .onChange(async (value) => {
            this.plugin.settings.mcpDnsRebindingProtection = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Session timeout (minutes)")
      .setDesc("Inactive sessions are automatically closed after this duration")
      .addText((text) =>
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.mcpSessionTimeoutMinutes))
          .onChange(async (val) => {
            const parsed = Number(val);
            if (!Number.isNaN(parsed) && parsed > 0) {
              this.plugin.settings.mcpSessionTimeoutMinutes = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Enable HTTPS")
      .setDesc("Use HTTPS instead of HTTP. Required for Claude Desktop.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.mcpHttpsEnabled)
          .onChange(async (value) => {
            this.plugin.settings.mcpHttpsEnabled = value;
            await this.plugin.saveSettings();
            this.display(); // Refresh to show/hide TLS settings
          })
      );

    // Only show TLS settings when HTTPS is enabled
    if (this.plugin.settings.mcpHttpsEnabled) {
      new Setting(containerEl)
        .setName("TLS certificate")
        .setDesc("Paste the contents of your mkcert certificate (PEM format)")
        .addTextArea((text) =>
          text
            .setPlaceholder("-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----")
            .setValue(this.plugin.settings.mcpTlsCert)
            .onChange(async (value) => {
              this.plugin.settings.mcpTlsCert = value;
              await this.plugin.saveSettings();
            })
        )
        .then((setting) => {
          const textarea = setting.controlEl.querySelector("textarea");
          if (textarea) {
            textarea.style.width = "100%";
            textarea.style.height = "100px";
            textarea.style.fontFamily = "monospace";
            textarea.style.fontSize = "11px";
          }
        });

      new Setting(containerEl)
        .setName("TLS private key")
        .setDesc("Paste the contents of your mkcert private key (PEM format)")
        .addTextArea((text) =>
          text
            .setPlaceholder("-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----")
            .setValue(this.plugin.settings.mcpTlsKey)
            .onChange(async (value) => {
              this.plugin.settings.mcpTlsKey = value;
              await this.plugin.saveSettings();
            })
        )
        .then((setting) => {
          const textarea = setting.controlEl.querySelector("textarea");
          if (textarea) {
            textarea.style.width = "100%";
            textarea.style.height = "100px";
            textarea.style.fontFamily = "monospace";
            textarea.style.fontSize = "11px";
          }
        });

      containerEl.createEl("p", {
        text: "Generate certificates: mkcert localhost 127.0.0.1",
        cls: "setting-item-description",
      });
    }

    // Claude Desktop Configuration
    this.renderClaudeDesktopConfig(containerEl);

    // Vector Search Settings
    containerEl.createEl("h3", { text: "Vector Search" });

    new Setting(containerEl)
      .setName("Enable auto-indexing")
      .setDesc("Automatically embed files when they change")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.vectorSearch.autoIndex)
          .onChange(async (value) => {
            this.plugin.settings.vectorSearch.autoIndex = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Embedding provider")
      .setDesc("Choose the embedding service to use")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("ollama", "Ollama (local)")
          .addOption("openai", "OpenAI")
          .setValue(this.plugin.settings.vectorSearch.embeddingProvider)
          .onChange(async (value) => {
            this.plugin.settings.vectorSearch.embeddingProvider = value as "ollama" | "openai";
            this.plugin.vectorIndexer?.updateSettings(this.plugin.settings.vectorSearch);
            await this.plugin.saveSettings();
            this.display(); // Refresh to show provider-specific settings
          })
      );

    // Conditionally show provider-specific settings
    if (this.plugin.settings.vectorSearch.embeddingProvider === "ollama") {
      this.renderOllamaSettings(containerEl);
    } else {
      this.renderOpenAISettings(containerEl);
    }

    new Setting(containerEl)
      .setName("Reindex vault")
      .setDesc("Force re-embed all markdown files")
      .addButton((btn) =>
        btn.setButtonText("Reindex Now").onClick(async () => {
          const indexer = this.plugin.vectorIndexer;
          if (!indexer) {
            new Notice("Vector indexer not initialized");
            return;
          }

          const available = await indexer.checkProviderConnection();
          if (!available) {
            const provider = this.plugin.settings.vectorSearch.embeddingProvider;
            if (provider === "ollama") {
              new Notice("Cannot connect to Ollama. Is it running?");
            } else {
              new Notice("Cannot connect to OpenAI. Check your API key.");
            }
            return;
          }

          new Notice("Starting vault reindex...");
          const result = await indexer.reindexVault((file, current, total) => {
            if (current % 10 === 0 || current === total) {
              console.log(`F9 MCP: Indexing ${current}/${total}: ${file}`);
            }
          });

          if (result.errors.length > 0) {
            new Notice(
              `Indexed ${result.indexed} files with ${result.errors.length} errors. Check console for details.`
            );
            console.error("F9 MCP: Indexing errors:", result.errors);
          } else {
            new Notice(`Successfully indexed ${result.indexed} files`);
          }
        })
      );

    // Show index stats
    const stats = this.plugin.vectorIndexer?.getStats();
    if (stats) {
      new Setting(containerEl)
        .setName("Index status")
        .setDesc(
          `${stats.fileCount} files, ${stats.chunkCount} chunks indexed using ${stats.providerKey}`
        );
    }
  }

  /**
   * Render Ollama-specific settings.
   */
  private renderOllamaSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Ollama URL")
      .setDesc("URL of your Ollama instance")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:11434")
          .setValue(this.plugin.settings.vectorSearch.ollamaUrl)
          .onChange(async (value) => {
            this.plugin.settings.vectorSearch.ollamaUrl = value;
            this.plugin.vectorIndexer?.updateSettings(this.plugin.settings.vectorSearch);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Embedding model")
      .setDesc("Ollama model for generating embeddings")
      .addText((text) =>
        text
          .setPlaceholder("nomic-embed-text:latest")
          .setValue(this.plugin.settings.vectorSearch.embeddingModel)
          .onChange(async (value) => {
            this.plugin.settings.vectorSearch.embeddingModel = value;
            this.plugin.vectorIndexer?.updateSettings(this.plugin.settings.vectorSearch);
            await this.plugin.saveSettings();
          })
      );
  }

  /**
   * Render OpenAI-specific settings.
   */
  private renderOpenAISettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("OpenAI API key")
      .setDesc("Your OpenAI API key (stored locally)")
      .addText((text) => {
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.vectorSearch.openaiApiKey)
          .onChange(async (value) => {
            this.plugin.settings.vectorSearch.openaiApiKey = value;
            this.plugin.vectorIndexer?.updateSettings(this.plugin.settings.vectorSearch);
            await this.plugin.saveSettings();
          });
        // Make it a password field for security
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
      });

    // OpenAI model selector with common models + custom option
    const openaiModels = [
      "text-embedding-3-small",
      "text-embedding-3-large",
      "text-embedding-ada-002",
    ];
    const currentModel = this.plugin.settings.vectorSearch.openaiModel;
    const isCustomModel = !openaiModels.includes(currentModel);

    new Setting(containerEl)
      .setName("Embedding model")
      .setDesc("OpenAI embedding model to use")
      .addDropdown((dropdown) => {
        dropdown.addOption("text-embedding-3-small", "text-embedding-3-small (1536 dim, cheapest)");
        dropdown.addOption("text-embedding-3-large", "text-embedding-3-large (3072 dim, best)");
        dropdown.addOption("text-embedding-ada-002", "text-embedding-ada-002 (1536 dim, legacy)");
        dropdown.addOption("custom", "Custom model...");
        dropdown.setValue(isCustomModel ? "custom" : currentModel);
        dropdown.onChange(async (value) => {
          if (value !== "custom") {
            this.plugin.settings.vectorSearch.openaiModel = value;
            this.plugin.vectorIndexer?.updateSettings(this.plugin.settings.vectorSearch);
            await this.plugin.saveSettings();
          }
          this.display(); // Refresh to show/hide custom input
        });
      });

    // Show custom model input if custom is selected
    if (isCustomModel || this.plugin.settings.vectorSearch.openaiModel === "custom") {
      new Setting(containerEl)
        .setName("Custom model name")
        .setDesc("Enter the model identifier")
        .addText((text) =>
          text
            .setPlaceholder("text-embedding-3-small")
            .setValue(isCustomModel ? currentModel : "")
            .onChange(async (value) => {
              if (value) {
                this.plugin.settings.vectorSearch.openaiModel = value;
                this.plugin.vectorIndexer?.updateSettings(this.plugin.settings.vectorSearch);
                await this.plugin.saveSettings();
              }
            })
        );
    }

    // Optional custom API endpoint
    new Setting(containerEl)
      .setName("Custom API endpoint (optional)")
      .setDesc("For Azure OpenAI or compatible APIs. Leave empty for standard OpenAI.")
      .addText((text) =>
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(this.plugin.settings.vectorSearch.openaiBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.vectorSearch.openaiBaseUrl = value;
            this.plugin.vectorIndexer?.updateSettings(this.plugin.settings.vectorSearch);
            await this.plugin.saveSettings();
          })
      );
  }

  /**
   * Generate a URL-safe slug from the vault name.
   */
  private getVaultSlug(): string {
    const vaultName = this.app.vault.getName();
    return vaultName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  /**
   * Generate the Claude Desktop configuration JSON.
   */
  private generateClaudeDesktopConfig(): string {
    const vaultSlug = this.getVaultSlug();
    const protocol = this.plugin.settings.mcpHttpsEnabled ? "https" : "http";
    const port = this.plugin.settings.mcpPort;
    const mcpUrl = `${protocol}://localhost:${port}/mcp`;

    interface ConfigEntry {
      command: string;
      args: string[];
      env?: Record<string, string>;
    }

    const config: ConfigEntry = {
      command: "npx",
      args: ["-y", "mcp-remote", mcpUrl],
    };

    // Add NODE_TLS_REJECT_UNAUTHORIZED for HTTPS with self-signed certs
    if (this.plugin.settings.mcpHttpsEnabled) {
      config.env = {
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      };
    }

    // Format as a single entry that can be added to mcpServers
    const wrapper: Record<string, ConfigEntry> = {};
    wrapper[`f9-obsidian-${vaultSlug}`] = config;

    return JSON.stringify(wrapper, null, 2);
  }

  /**
   * Render the Claude Desktop configuration section.
   */
  private renderClaudeDesktopConfig(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Claude Desktop Configuration" });

    const protocol = this.plugin.settings.mcpHttpsEnabled ? "https" : "http";
    const port = this.plugin.settings.mcpPort;

    containerEl.createEl("p", {
      text: `MCP endpoint: ${protocol}://localhost:${port}/mcp`,
      cls: "setting-item-description",
    });

    const configJson = this.generateClaudeDesktopConfig();

    new Setting(containerEl)
      .setName("claude_desktop_config.json snippet")
      .setDesc("Add this to your Claude Desktop config file under \"mcpServers\"")
      .addButton((btn) =>
        btn
          .setButtonText("Copy")
          .setCta()
          .onClick(() => {
            navigator.clipboard.writeText(configJson);
            new Notice("Configuration copied to clipboard");
          })
      );

    // Display the config in a read-only textarea
    const configDisplay = containerEl.createEl("textarea", {
      text: configJson,
      cls: "f9-mcp-config-display",
    });
    configDisplay.readOnly = true;
    configDisplay.style.width = "100%";
    configDisplay.style.height = "140px";
    configDisplay.style.fontFamily = "monospace";
    configDisplay.style.fontSize = "11px";
    configDisplay.style.marginBottom = "1em";
    configDisplay.style.resize = "vertical";

    // Add terminal command hint
    containerEl.createEl("p", {
      text: `Or run directly: npx -y mcp-remote ${protocol}://localhost:${port}/mcp`,
      cls: "setting-item-description",
    });
  }
}
