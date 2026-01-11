import { App, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";
import { ObsidianMcpHost, McpConfig } from "./mcp/host";
import { VectorIndexer } from "./vector/indexer";
import { VectorSearchSettings, DEFAULT_VECTOR_SETTINGS } from "./vector/types";

interface F9ObsidianMCPSettings {
  sampleSetting: boolean;
  mcpEnabled: boolean;
  mcpPort: number;
  mcpDnsRebindingProtection: boolean;
  mcpTlsCertPath: string;
  mcpTlsKeyPath: string;
  vectorSearch: VectorSearchSettings;
}

const DEFAULT_SETTINGS: F9ObsidianMCPSettings = {
  sampleSetting: true,
  mcpEnabled: false,
  mcpPort: 3030,
  mcpDnsRebindingProtection: true,
  mcpTlsCertPath: "",
  mcpTlsKeyPath: "",
  vectorSearch: DEFAULT_VECTOR_SETTINGS,
};

export default class F9ObsidianMCPPlugin extends Plugin {
  settings!: F9ObsidianMCPSettings;
  private mcpHost?: ObsidianMcpHost;
  vectorIndexer?: VectorIndexer;

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

    const statusBar = this.addStatusBarItem();
    statusBar.setText("F9 MCP ready");

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
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...await this.loadData()};
  }

  async saveSettings() {
    await this.saveData(this.settings);
    await this.ensureMcpRunning();
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
      tls: {
        certPath: this.settings.mcpTlsCertPath,
        keyPath: this.settings.mcpTlsKeyPath,
      },
    };

    this.mcpHost ??= new ObsidianMcpHost(this.app, cfg, this.vectorIndexer);

    // Restart with latest config
    if (cfg.enabled) {
      try {
        await this.mcpHost.restart(cfg);
        console.log(
          `F9 Obsidian MCP server listening on https://127.0.0.1:${cfg.port}/mcp`
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
      .setName("Sample toggle")
      .setDesc("A sample setting to get started.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.sampleSetting)
          .onChange(async (value) => {
            this.plugin.settings.sampleSetting = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Enable MCP server")
      .setDesc(
        "Host an MCP server inside Obsidian (HTTPS on 127.0.0.1). Requires mkcert certificates."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.mcpEnabled)
          .onChange(async (value) => {
            this.plugin.settings.mcpEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("MCP port")
      .setDesc("Local port for the MCP HTTPS endpoint")
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
      .setDesc("Validate Host header for local HTTPS requests")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.mcpDnsRebindingProtection)
          .onChange(async (value) => {
            this.plugin.settings.mcpDnsRebindingProtection = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("TLS certificate file")
      .setDesc("Path to mkcert certificate (e.g., localhost+1.pem)")
      .addText((text) =>
        text
          .setPlaceholder("/path/to/localhost+1.pem")
          .setValue(this.plugin.settings.mcpTlsCertPath)
          .onChange(async (value) => {
            this.plugin.settings.mcpTlsCertPath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("TLS key file")
      .setDesc("Path to mkcert private key (e.g., localhost+1-key.pem)")
      .addText((text) =>
        text
          .setPlaceholder("/path/to/localhost+1-key.pem")
          .setValue(this.plugin.settings.mcpTlsKeyPath)
          .onChange(async (value) => {
            this.plugin.settings.mcpTlsKeyPath = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("p", {
      text: "Generate certificates: mkcert localhost 127.0.0.1",
      cls: "setting-item-description",
    });

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

          const available = await indexer.checkOllamaConnection();
          if (!available) {
            new Notice("Cannot connect to Ollama. Is it running?");
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
          `${stats.fileCount} files, ${stats.chunkCount} chunks indexed using ${stats.model}`
        );
    }
  }
}
