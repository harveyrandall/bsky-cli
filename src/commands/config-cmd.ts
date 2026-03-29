import { Command } from "commander";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { configFilePath, generateDefaultConfig } from "@/toml-config";

export function registerConfig(program: Command): void {
  const config = program
    .command("config")
    .description("Manage bsky-cli configuration");

  config
    .command("init")
    .description("Create default config file")
    .action(() => {
      const fp = configFilePath(program.opts().config);
      if (existsSync(fp)) {
        console.log(`Config file already exists: ${fp}`);
        return;
      }
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, generateDefaultConfig(), { mode: 0o644 });
      console.log(`Created config file: ${fp}`);
    });

  config
    .command("path")
    .description("Print config file path")
    .action(() => {
      console.log(configFilePath(program.opts().config));
    });

  config
    .command("show")
    .description("Print config file contents")
    .action(() => {
      const fp = configFilePath(program.opts().config);
      if (!existsSync(fp)) {
        console.error(`No config file found at: ${fp}`);
        console.error('Run "bsky config init" to create one.');
        process.exit(1);
      }
      console.log(readFileSync(fp, "utf-8"));
    });

  config
    .command("edit")
    .description("Open config file in $EDITOR")
    .action(() => {
      const fp = configFilePath(program.opts().config);
      if (!existsSync(fp)) {
        console.error(`No config file found at: ${fp}`);
        console.error('Run "bsky config init" to create one.');
        process.exit(1);
      }
      const editor = process.env.EDITOR || "vi";
      execFileSync(editor, [fp], { stdio: "inherit" });
    });
}
