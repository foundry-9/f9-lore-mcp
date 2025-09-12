import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";

interface F9ObsidianMCPSettings {
  sampleSetting: boolean;
}

const DEFAULT_SETTINGS: F9ObsidianMCPSettings = {
  sampleSetting: true,
};

export default class F9ObsidianMCPPlugin extends Plugin {
  settings: F9ObsidianMCPSettings;

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
  }

  onunload() {
    console.log("Unloading plugin: F9 Obsidian MCP");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
  }
}

