import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, setTooltip } from "obsidian";
import { LoreMcpHost, McpConfig } from "./mcp/host";
import { VectorIndexer } from "./vector/indexer";
import { VectorSearchSettings, DEFAULT_VECTOR_SETTINGS } from "./vector/types";
import type { ExtendedIndexingStatus } from "./vector/types";
import { truncateString } from "./mcp/utils";


/**
 * Workaround to allow special words into UI with correct casing,
 * and sentence-case the rest.
 *
 * @param {string} text
 * @return {*} 
 */
const allowUiSpecialWords = (text:string): string => {
  const acronyms = ["MCP", "SSE", "TF-IDF", "IDF", "URL", "API", "HTTPS", "TLS", "DNS"];
  const brands = ["Ollama", "OpenAI", "Claude", "Claude Desktop", "Lore MCP", "Azure OpenAI"];
  const specialWords = ["Host"];
  if([...acronyms, ...brands, ...specialWords].includes(text)) {
    return text; // already has correct casing
  }

  // Source - https://stackoverflow.com/a
  // Posted by Samuli Hakoniemi, modified by community. See post 'Timeline' for change history
  // Retrieved 2026-01-20, License - CC BY-SA 3.0

  const rg = /(^\w{1}|\.\s*\w{1})/gi;
  text = text.replace(rg, (toReplace) => toReplace.toUpperCase());
  return text;
}

/**
 * Internal Obsidian setting manager interface (not part of public API).
 * Used to programmatically open plugin settings.
 */
interface ObsidianSettingManager {
  open(): void;
  openTabById(id: string): void;
}

/**
 * Extended App interface with internal setting property.
 */
interface AppWithSettings extends App {
  setting: ObsidianSettingManager;
}

interface F9LoreMCPSettings {
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
  vaults: Record<string, F9LoreMCPSettings>;
}

const DEFAULT_SETTINGS: F9LoreMCPSettings = {
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

/** Which accordion to auto-open when settings are displayed */
export type PendingAccordion = "mcp" | "vector" | null;

export default class F9LoreMCPPlugin extends Plugin {
  settings!: F9LoreMCPSettings;
  mcpHost?: LoreMcpHost;
  vectorIndexer?: VectorIndexer;
  private statusBarItem?: HTMLElement;
  private mcpRestartTimer?: ReturnType<typeof setTimeout>;
  /** Tracks which accordion should be opened next time settings are displayed */
  pendingAccordion: PendingAccordion = null;
  /** Last MCP error message for display in settings */
  lastMcpError: string | null = null;

  /** Icons for different health states */
  private readonly STATUS_ICONS = {
    ok: "\u2713",      // ✓
    busy: ["\u25D0", "\u25D3", "\u25D1", "\u25D2"], // spinning circle phases
    warning: "\u26A0", // ⚠
    error: "\u2716",   // ✖
  };
  /** Current frame of the spinner animation */
  private spinnerFrame = 0;

  async onload() {
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
        void this.vectorIndexer?.checkForStaleFiles();
      }, 2000);
    }

    const ribbon = this.addRibbonIcon(
      "dice",
      allowUiSpecialWords("F9 Lore MCP"),
      () => {
        new Notice(allowUiSpecialWords("Hello from the Lore MCP plugin!"));
      }
    );
    ribbon.addClass("f9-lore-mcp-ribbon-icon");

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("mod-clickable");
    this.statusBarItem.addEventListener("click", () => this.openSettingsWithContext());
    this.updateStatusBar();

    // Update status bar frequently for responsive spinner animation
    this.registerInterval(
      window.setInterval(() => this.updateStatusBar(), 500)
    );

    this.addCommand({
      id: "say-hello",
      name: "Say hello",
      callback: () => new Notice(allowUiSpecialWords("Lore MCP says hello")),
    });

    this.addSettingTab(new F9LoreMCPSettingTab(this.app, this));

    // Start MCP server if enabled
    await this.ensureMcpRunning();
  }

  onunload() {
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
      const oldSettings = rawData as Partial<F9LoreMCPSettings>;
      this.settings = { ...DEFAULT_SETTINGS, ...oldSettings };
      // Save in new format immediately to complete migration
      await this.saveSettings();
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
      this.ensureMcpRunning().catch(() => {
        // Error during scheduled restart
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

    this.mcpHost ??= new LoreMcpHost(this.app, cfg, this.vectorIndexer);

    // Restart with latest config
    if (cfg.enabled) {
      try {
        await this.mcpHost.restart(cfg);
        this.lastMcpError = null; // Clear error on successful start
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.lastMcpError = message;
        new Notice(`MCP server error: ${message}`);
      }
    } else {
      this.lastMcpError = null; // Clear error when disabled
      await this.mcpHost.stop();
    }
  }

  private updateStatusBar(): void {
    if (!this.statusBarItem) return;

    const status = this.vectorIndexer?.getIndexingStatus();
    const stats = this.vectorIndexer?.getStats();
    const mcpRunning = this.mcpHost?.isRunning() ?? false;

    // Check for TF-IDF vocabulary drift
    const hasDrift = stats?.tfidfDrift && stats.tfidfDrift.unknownTermsCount > 0;

    // Determine icon based on health state (drift also triggers warning)
    let icon: string;
    const healthState = status?.healthState ?? "ok";
    if (healthState === "busy") {
      this.spinnerFrame = (this.spinnerFrame + 1) % this.STATUS_ICONS.busy.length;
      icon = this.STATUS_ICONS.busy[this.spinnerFrame];
    } else if (healthState === "warning" || hasDrift) {
      icon = this.STATUS_ICONS.warning;
    } else {
      icon = this.STATUS_ICONS[healthState];
    }

    // Build display text
    const parts: string[] = [`${icon} F9`];

    // Add progress or pending count
    if (status?.progress) {
      parts.push(`${status.progress.current}/${status.progress.total}`);
    } else if (status?.pendingCount && status.pendingCount > 0) {
      parts.push(`${status.pendingCount} pending`);
    }

    this.statusBarItem.setText(parts.join(" "));

    // Update tooltip with detailed information
    this.updateTooltip(status, stats, mcpRunning);
  }

  private updateTooltip(
    status: ExtendedIndexingStatus | undefined,
    stats: ReturnType<VectorIndexer["getStats"]> | undefined,
    mcpRunning: boolean
  ): void {
    if (!this.statusBarItem) return;

    const lines: string[] = [];
    lines.push(`F9 Lore MCP - Port ${this.settings.mcpPort}`);

    // MCP status
    if (mcpRunning) {
      const sessionCount = this.mcpHost!.getSessionCount();
      lines.push(`MCP: ${sessionCount} session${sessionCount !== 1 ? "s" : ""}`);
    } else if (this.settings.mcpEnabled) {
      lines.push("MCP: Starting...");
    } else {
      lines.push("MCP: Disabled");
    }

    // Indexing status
    if (status?.progress) {
      lines.push("");
      lines.push(`Indexing: ${status.progress.current}/${status.progress.total}`);
      lines.push(`Current: ${truncateString(status.progress.currentFile, 40, true)}`);
    } else if (status?.pendingCount && status.pendingCount > 0) {
      lines.push("");
      lines.push(`${status.pendingCount} file${status.pendingCount !== 1 ? "s" : ""} pending`);
    }

    // Show last error if recent (within 5 minutes)
    if (status?.lastError) {
      const ageMs = Date.now() - status.lastError.timestamp;
      if (ageMs < 5 * 60 * 1000) {
        lines.push("");
        const ageSec = Math.floor(ageMs / 1000);
        const ageStr = ageSec < 60 ? `${ageSec}s` : `${Math.floor(ageSec / 60)}m`;
        lines.push(`Error (${ageStr} ago):`);
        if (status.lastError.filePath) {
          lines.push(truncateString(status.lastError.filePath, 35, true));
        }
        lines.push(truncateString(status.lastError.message, 50));
      }
    }

    // TF-IDF vocabulary drift warning
    if (stats?.tfidfDrift && stats.tfidfDrift.unknownTermsCount > 0) {
      lines.push("");
      lines.push(`Vocabulary drift: ${stats.tfidfDrift.unknownTermsCount} new terms (${stats.tfidfDrift.driftPercentage}%)`);
      lines.push("Consider reindexing vault");
    }

    // Index stats and embedding provider
    if (stats) {
      lines.push("");
      lines.push(`Index: ${stats.fileCount} files, ${stats.chunkCount} chunks`);
      lines.push(`Embedding: ${stats.providerKey}`);
    }

    setTooltip(this.statusBarItem, lines.join("\n"), { placement: "top" });
  }

  /**
   * Open plugin settings, auto-expanding the appropriate accordion based on current errors.
   */
  openSettingsWithContext(): void {
    // Determine which accordion to open based on current state
    if (this.lastMcpError) {
      this.pendingAccordion = "mcp";
    } else {
      const status = this.vectorIndexer?.getIndexingStatus();
      const stats = this.vectorIndexer?.getStats();
      const hasDrift = stats?.tfidfDrift && stats.tfidfDrift.unknownTermsCount > 0;
      const hasRecentError = status?.lastError &&
        Date.now() - status.lastError.timestamp < 5 * 60 * 1000;

      if (hasRecentError || hasDrift) {
        this.pendingAccordion = "vector";
      } else {
        this.pendingAccordion = null;
      }
    }

    // Open settings and navigate to this plugin's tab
    const appWithSettings = this.app as AppWithSettings;
    appWithSettings.setting.open();
    appWithSettings.setting.openTabById(this.manifest.id);
  }
}

class F9LoreMCPSettingTab extends PluginSettingTab {
  plugin: F9LoreMCPPlugin;
  /** Track the previous embedding provider to detect type changes */
  private previousEmbeddingProvider: string;

  constructor(app: App, plugin: F9LoreMCPPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.previousEmbeddingProvider = plugin.settings.vectorSearch.embeddingProvider;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Capture and clear the pending accordion (one-time use)
    const openAccordion = this.plugin.pendingAccordion;
    this.plugin.pendingAccordion = null;

    // Status section at the top
    this.renderStatusSection(containerEl);

    // MCP server accordion
    this.renderAccordion(containerEl, "MCP server", openAccordion === "mcp", (content) => {
      this.renderMcpSettings(content);
    });

    // Claude desktop configuration accordion
    this.renderAccordion(containerEl, "Claude desktop configuration", false, (content) => {
      this.renderClaudeDesktopConfig(content);
    });

    // Vector search accordion
    this.renderAccordion(containerEl, "Vector search", openAccordion === "vector", (content) => {
      this.renderVectorSearchSettings(content);
    });

    // Help text section
    this.renderHelpSection(containerEl);
  }

  /**
   * Render the help text section below the accordions.
   */
  private renderHelpSection(containerEl: HTMLElement): void {
    const helpContainer = containerEl.createEl("div", {
      cls: "f9-help-section",
    });

    // MCP Connection
    new Setting(helpContainer).setName(allowUiSpecialWords("MCP connection")).setHeading();
    helpContainer.createEl("p", {
      text: allowUiSpecialWords("This server uses streamable SSE transport only. If your client requires stdio (as some MCP integrations do), you can bridge the connection using MCP-remote or a similar proxy. The default configuration snippet for Claude Desktop includes MCP-remote already, so it should just work. Once connected, you can instruct Claude to access your vault exclusively through this MCP—giving you a controlled, obsidian-native channel for ai interaction with your notes."),
      cls: "f9-help-text",
    });

    // Search: TF-IDF
    new Setting(helpContainer).setName(allowUiSpecialWords("Search: TF-IDF")).setHeading();
    helpContainer.createEl("p", {
      text: allowUiSpecialWords("The built-in TF-IDF search is fast and free, but it's only as smart as your own organization. It matches words, not meaning—so if your vault uses consistent terminology and well-structured links, it will serve you well. If your notes are more freeform or you need genuine semantic understanding, consider enabling Ollama or OpenAI embeddings instead."),
      cls: "f9-help-text",
    });
    helpContainer.createEl("p", {
      text: allowUiSpecialWords("Note that TF-IDF learns its vocabulary from your existing notes at index time. If you add significant new terminology over time—new characters, locations, concepts—you'll want to reindex your vault so the search can recognize and weight those terms properly."),
      cls: "f9-help-text",
    });

    // Search: embeddings
    new Setting(helpContainer).setName(allowUiSpecialWords("Search: embeddings (Ollama / OpenAI)")).setHeading();
    helpContainer.createEl("p", {
      text: allowUiSpecialWords("Embedding-based search understands language, not just keywords. It can find conceptually related notes even when the wording differs. The trade-off is cost (for OpenAI) or local compute (for Ollama). Use this if your vault is large, loosely organized, or if you frequently search for ideas rather than specific terms."),
      cls: "f9-help-text",
    });
    helpContainer.createEl("p", {
      text: "When you edit or create notes, the plugin automatically updates their embeddings to keep search results current.",
      cls: "f9-help-text",
    });
  }

  /**
   * Render an accordion/collapsible section.
   */
  private renderAccordion(
    containerEl: HTMLElement,
    title: string,
    defaultOpen: boolean,
    renderContent: (contentEl: HTMLElement) => void
  ): void {
    const details = containerEl.createEl("details", {
      cls: "f9-settings-accordion",
    });
    if (defaultOpen) {
      details.setAttribute("open", "");
    }

    const summary = details.createEl("summary", {
      cls: "f9-settings-accordion-summary",
    });
    summary.createEl("span", { text: title });

    const content = details.createEl("div", {
      cls: "f9-settings-accordion-content",
    });

    renderContent(content);
  }

  /**
   * Render the status section showing current plugin state.
   */
  private renderStatusSection(containerEl: HTMLElement): void {
    const statusContainer = containerEl.createEl("div", {
      cls: "f9-status-section",
    });

    const mcpRunning = this.plugin.mcpHost?.isRunning() ?? false;
    const sessionCount = this.plugin.mcpHost?.getSessionCount() ?? 0;
    const indexingStatus = this.plugin.vectorIndexer?.getIndexingStatus();
    const stats = this.plugin.vectorIndexer?.getStats();

    // MCP Status row
    const mcpRow = statusContainer.createEl("div", { cls: "f9-status-row" });
    const hasMcpError = !!this.plugin.lastMcpError;
    const mcpIcon = mcpRunning ? "\u2713" : hasMcpError ? "\u2716" : "\u2716"; // ✓ or ✖
    const mcpStatus = mcpRunning
      ? `Listening on port ${this.plugin.settings.mcpPort}`
      : hasMcpError
        ? "Error"
        : this.plugin.settings.mcpEnabled
          ? "Starting..."
          : "Disabled";
    mcpRow.createEl("span", {
      text: `${mcpIcon} MCP: ${mcpStatus}`,
      cls: mcpRunning ? "f9-status-ok" : hasMcpError ? "f9-status-error" : "f9-status-off",
    });
    if (mcpRunning) {
      mcpRow.createEl("span", {
        text: ` | ${sessionCount} session${sessionCount !== 1 ? "s" : ""}`,
        cls: "f9-status-detail",
      });
    }
    if (hasMcpError) {
      mcpRow.createEl("span", {
        text: ` | ${truncateString(this.plugin.lastMcpError!, 50)}`,
        cls: "f9-status-error",
      });
    }

    // Index Status row
    const indexRow = statusContainer.createEl("div", { cls: "f9-status-row" });
    const fileCount = stats?.fileCount ?? 0;
    const chunkCount = stats?.chunkCount ?? 0;

    let indexStatusText = `Index: ${fileCount} files, ${chunkCount} chunks`;
    if (indexingStatus?.progress) {
      indexStatusText += ` | Indexing ${indexingStatus.progress.current}/${indexingStatus.progress.total}`;
    } else if (indexingStatus?.pendingCount && indexingStatus.pendingCount > 0) {
      indexStatusText += ` | ${indexingStatus.pendingCount} pending`;
    }

    indexRow.createEl("span", {
      text: indexStatusText,
      cls: "f9-status-detail",
    });

    // Embedding provider row
    const providerRow = statusContainer.createEl("div", { cls: "f9-status-row" });
    const providerKey = stats?.providerKey ?? "none";
    providerRow.createEl("span", {
      text: `Embedding: ${providerKey}`,
      cls: "f9-status-detail",
    });

    // Add some spacing after status section
    containerEl.createEl("div", { cls: "f9-status-spacer" });
  }

  /**
   * Render MCP server settings.
   */
  private renderMcpSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName(allowUiSpecialWords("Enable MCP server"))
      .setDesc(allowUiSpecialWords("Host an MCP server inside obsidian on 127.0.0.1"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.mcpEnabled)
          .onChange(async (value) => {
            this.plugin.settings.mcpEnabled = value;
            await this.plugin.saveSettings();
            this.display(); // Refresh to update status
          })
      );

    new Setting(containerEl)
      .setName(allowUiSpecialWords("MCP port"))
      .setDesc(allowUiSpecialWords("Local port for the MCP endpoint"))
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
      .setName(allowUiSpecialWords("DNS rebinding protection"))
      .setDesc(allowUiSpecialWords("Validate Host header for local requests"))
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
      .setName(allowUiSpecialWords("Enable https"))
      .setDesc(allowUiSpecialWords("Use https instead of http. Required for Claude Desktop."))
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
        .setName(allowUiSpecialWords("TLS certificate"))
        .setDesc(allowUiSpecialWords("Paste the contents of your mkcert certificate (PEM format)"))
        .addTextArea((text) =>
          text
            .setPlaceholder("-----begin certificate-----\n...\n-----end certificate-----")
            .setValue(this.plugin.settings.mcpTlsCert)
            .onChange(async (value) => {
              this.plugin.settings.mcpTlsCert = value;
              await this.plugin.saveSettings();
            })
        )
        .then((setting) => {
          const textarea = setting.controlEl.querySelector("textarea");
          if (textarea) {
            textarea.addClass("f9-monospace-textarea");
          }
        });

      new Setting(containerEl)
        .setName(allowUiSpecialWords("TLS private key"))
        .setDesc(allowUiSpecialWords("Paste the contents of your mkcert private key (PEM format)"))
        .addTextArea((text) =>
          text
            .setPlaceholder("-----begin private key-----\n...\n-----end private key-----")
            .setValue(this.plugin.settings.mcpTlsKey)
            .onChange(async (value) => {
              this.plugin.settings.mcpTlsKey = value;
              await this.plugin.saveSettings();
            })
        )
        .then((setting) => {
          const textarea = setting.controlEl.querySelector("textarea");
          if (textarea) {
            textarea.addClass("f9-monospace-textarea");
          }
        });

      containerEl.createEl("p", {
        text: "Generate certificates: mkcert localhost 127.0.0.1",
        cls: "setting-item-description",
      });
    }
  }

  /**
   * Render vector search settings.
   */
  private renderVectorSearchSettings(containerEl: HTMLElement): void {
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
      .setName("Indexing delay (seconds)")
      .setDesc("Wait for file to be unchanged for this duration before indexing")
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.vectorSearch.debounceMs / 1000))
          .onChange(async (val) => {
            const parsed = Number(val);
            if (!Number.isNaN(parsed) && parsed >= 0) {
              this.plugin.settings.vectorSearch.debounceMs = parsed * 1000;
              this.plugin.vectorIndexer?.updateSettings(this.plugin.settings.vectorSearch);
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Embedding provider")
      .setDesc("Choose the embedding service to use")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("ollama", "Ollama (local)")
          .addOption("openai", allowUiSpecialWords("OpenAI"))
          .addOption("tfidf", allowUiSpecialWords("TF-IDF (no network required)"))
          .setValue(this.plugin.settings.vectorSearch.embeddingProvider)
          .onChange(async (value) => {
            const newProvider = value as "ollama" | "openai" | "tfidf";
            const oldProvider = this.previousEmbeddingProvider;

            this.plugin.settings.vectorSearch.embeddingProvider = newProvider;
            this.plugin.vectorIndexer?.updateSettings(this.plugin.settings.vectorSearch);
            await this.plugin.saveSettings();

            // If the provider type changed, trigger a full reindex
            if (oldProvider !== newProvider) {
              this.previousEmbeddingProvider = newProvider;
              await this.triggerProviderChangeReindex(newProvider);
            }

            this.display(); // Refresh to show provider-specific settings
          })
      );

    // Conditionally show provider-specific settings
    if (this.plugin.settings.vectorSearch.embeddingProvider === "ollama") {
      this.renderOllamaSettings(containerEl);
    } else if (this.plugin.settings.vectorSearch.embeddingProvider === "openai") {
      this.renderOpenAISettings(containerEl);
    } else if (this.plugin.settings.vectorSearch.embeddingProvider === "tfidf") {
      this.renderTfidfSettings(containerEl);
    }

    // Index operations section
    new Setting(containerEl).setName("Index operations").setHeading();

    // Refresh Index button
    new Setting(containerEl)
      .setName("Refresh index")
      .setDesc("Check for files that have changed since last indexed and update them")
      .addButton((btn) =>
        btn.setButtonText("Refresh").onClick(async () => {
          const indexer = this.plugin.vectorIndexer;
          if (!indexer) {
            new Notice("Vector indexer not initialized");
            return;
          }

          const available = await indexer.checkProviderConnection();
          if (!available) {
            this.showProviderUnavailableNotice();
            return;
          }

          new Notice("Checking for stale files...");
          const staleCount = await indexer.checkForStaleFiles();

          if (staleCount > 0) {
            new Notice(`Found ${staleCount} stale file${staleCount !== 1 ? "s" : ""}, queueing for reindex`);
          } else {
            new Notice("Index is up to date");
          }
          this.display(); // Refresh to show updated status
        })
      );

    // Reindex Vault button with warning
    const reindexSetting = new Setting(containerEl)
      .setName("Reindex entire vault")
      .setDesc(
        "Force re-embed all markdown files. " +
        "This can be slow for large vaults and may incur API costs if using OpenAI."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Reindex vault")
          .setWarning()
          .onClick(async () => {
            const indexer = this.plugin.vectorIndexer;
            if (!indexer) {
              new Notice("Vector indexer not initialized");
              return;
            }

            const available = await indexer.checkProviderConnection();
            if (!available) {
              this.showProviderUnavailableNotice();
              return;
            }

            new Notice("Starting full vault reindex...");
            const result = await indexer.reindexVault();

            if (result.errors.length > 0) {
              new Notice(
                `Indexed ${result.indexed} files with ${result.errors.length} errors.`
              );
            } else {
              new Notice(`Successfully indexed ${result.indexed} files`);
            }
            this.display(); // Refresh to show updated stats
          })
      );

    // Add warning styling
    reindexSetting.settingEl.addClass("f9-reindex-warning");

    // Show index stats
    const stats = this.plugin.vectorIndexer?.getStats();
    if (stats) {
      let statusDesc = `${stats.fileCount} files, ${stats.chunkCount} chunks indexed`;

      // Add TF-IDF vocabulary drift info if available
      if (stats.tfidfDrift && stats.tfidfDrift.vocabularySize > 0) {
        statusDesc += ` | Vocabulary: ${stats.tfidfDrift.vocabularySize} terms`;
        if (stats.tfidfDrift.unknownTermsCount > 0) {
          statusDesc += ` | ${stats.tfidfDrift.unknownTermsCount} unknown terms (${stats.tfidfDrift.driftPercentage}% drift)`;
        }
      }

      new Setting(containerEl)
        .setName("Index status")
        .setDesc(statusDesc);

      // Show warning if significant vocabulary drift detected
      if (stats.tfidfDrift && stats.tfidfDrift.unknownTermsCount > 0) {
        const driftSetting = new Setting(containerEl)
          .setName("Vocabulary drift detected")
          .setDesc(
            `${stats.tfidfDrift.unknownTermsCount} new terms found since last reindex. ` +
            `Consider reindexing to improve search accuracy. ` +
            `Sample: ${stats.tfidfDrift.sampleUnknownTerms.slice(0, 5).join(", ")}${stats.tfidfDrift.sampleUnknownTerms.length > 5 ? "..." : ""}`
          );
        driftSetting.settingEl.addClass("mod-warning");
      }
    }
  }

  /**
   * Show a notice when the embedding provider is unavailable.
   */
  private showProviderUnavailableNotice(): void {
    const provider = this.plugin.settings.vectorSearch.embeddingProvider;
    if (provider === "ollama") {
      new Notice(allowUiSpecialWords("Cannot connect to Ollama. Is it running?"));
    } else if (provider === "openai") {
      new Notice(allowUiSpecialWords("Cannot connect to OpenAI. Check your api key."));
    }
    // TF-IDF is always available, so no error message needed
  }

  /**
   * Trigger a full reindex when the embedding provider type changes.
   */
  private async triggerProviderChangeReindex(newProvider: string): Promise<void> {
    const indexer = this.plugin.vectorIndexer;
    if (!indexer) return;

    const available = await indexer.checkProviderConnection();
    if (!available) {
      new Notice(
        `Switched to ${newProvider}. Provider not available - reindex when ready.`
      );
      return;
    }

    new Notice(`Switched to ${newProvider}. Starting full reindex...`);
    const result = await indexer.reindexVault();

    if (result.errors.length > 0) {
      new Notice(
        `Reindexed ${result.indexed} files with ${result.errors.length} errors.`
      );
    } else {
      new Notice(`Successfully reindexed ${result.indexed} files with ${newProvider}`);
    }
  }

  /**
   * Render Ollama-specific settings.
   */
  private renderOllamaSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName(allowUiSpecialWords("Ollama URL"))
      .setDesc(allowUiSpecialWords("URL of your Ollama instance"))
      .addText((text) =>
        text
          .setPlaceholder(allowUiSpecialWords("http://localhost:11434"))
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
          .setPlaceholder("Nomic-embed-text:latest")
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
      .setName(allowUiSpecialWords("OpenAI API key"))
      .setDesc(allowUiSpecialWords("Your OpenAI API key (stored locally)"))
      .addText((text) => {
        text
          .setPlaceholder("Sk-...")
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
      .setDesc(allowUiSpecialWords("OpenAI embedding model to use"))
      .addDropdown((dropdown) => {
        dropdown.addOption("text-embedding-3-small", "Text-embedding-3-small (1536 dim, cheapest)");
        dropdown.addOption("text-embedding-3-large", "Text-embedding-3-large (3072 dim, best)");
        dropdown.addOption("text-embedding-ada-002", "Text-embedding-ada-002 (1536 dim, legacy)");
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
            .setPlaceholder("Text-embedding-3-small")
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
      .setName(allowUiSpecialWords("Custom API endpoint (optional)"))
      .setDesc(allowUiSpecialWords("For Azure OpenAI or compatible APIs. Leave empty for standard OpenAI."))
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
   * Render TF-IDF-specific settings (informational only).
   */
  private renderTfidfSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName(allowUiSpecialWords("TF-IDF information"))
      .setDesc(
        "TF-IDF (Term Frequency-Inverse Document Frequency) is a keyword-based search method. " +
          "It works fully offline with no external services required. " +
          "Search quality is based on keyword matching rather than semantic understanding. " +
          "Indexing is instant since no embeddings are computed."
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
    wrapper[`f9-lore-${vaultSlug}`] = config;

    return JSON.stringify(wrapper, null, 2);
  }

  /**
   * Render the Claude Desktop configuration section.
   */
  private renderClaudeDesktopConfig(containerEl: HTMLElement): void {
    const protocol = this.plugin.settings.mcpHttpsEnabled ? "https" : "http";
    const port = this.plugin.settings.mcpPort;

    containerEl.createEl("p", {
      text: `MCP endpoint: ${protocol}://localhost:${port}/mcp`,
      cls: "setting-item-description",
    });

    const configJson = this.generateClaudeDesktopConfig();

    new Setting(containerEl)
      .setName(allowUiSpecialWords("claude_desktop_config.json snippet"))
      .setDesc(allowUiSpecialWords("Add this to your Claude Desktop config file under \"mcpServers\""))
      .addButton((btn) =>
        btn
          .setButtonText("Copy")
          .setCta()
          .onClick(() => {
            void navigator.clipboard.writeText(configJson);
            new Notice("Configuration copied to clipboard");
          })
      );

    // Display the config in a read-only textarea
    const configDisplay = containerEl.createEl("textarea", {
      text: configJson,
      cls: "f9-mcp-config-display",
    });
    configDisplay.readOnly = true;

    // Add terminal command hint
    containerEl.createEl("p", {
      text: `Or run directly: npx -y mcp-remote ${protocol}://localhost:${port}/mcp`,
      cls: "setting-item-description",
    });
  }
}
