import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { ObsidianMcpHost, McpConfig } from "./mcp/host";

interface F9ObsidianMCPSettings {
  sampleSetting: boolean;
  mcpEnabled: boolean;
  mcpPort: number;
  mcpDnsRebindingProtection: boolean;
}

const DEFAULT_SETTINGS: F9ObsidianMCPSettings = {
  sampleSetting: true,
  mcpEnabled: false,
  mcpPort: 3030,
  mcpDnsRebindingProtection: true,
};

export default class F9ObsidianMCPPlugin extends Plugin {
  settings: F9ObsidianMCPSettings;
  private mcpHost?: ObsidianMcpHost;

  async onload() {
    console.log("Loading plugin: F9 Obsidian MCP");
    await this.loadSettings();

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
    };

    this.mcpHost ??= new ObsidianMcpHost(this.app, cfg);

    // Restart with latest config
    if (cfg.enabled) {
      await this.mcpHost.restart(cfg);
      console.log(
        `F9 Obsidian MCP server listening on http://127.0.0.1:${cfg.port}/mcp`
      );
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
        "Host an MCP server inside Obsidian (local HTTP on 127.0.0.1)."
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
      .setDesc("Local port for the MCP HTTP endpoint")
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
      .setDesc("Validate Host header for local HTTP requests")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.mcpDnsRebindingProtection)
          .onChange(async (value) => {
            this.plugin.settings.mcpDnsRebindingProtection = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
