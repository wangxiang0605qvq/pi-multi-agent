#!/usr/bin/env node

/**
 * Post-install script for pi-multi-agent
 *
 * Automatically installs the extension to pi's extension directories:
 * 1. Creates ~/.pi/agent/extensions/pi-multi-agent/
 * 2. Symlinks the source files so pi can discover them
 *
 * Supports: Linux, macOS, Windows (via .bat helper and direct copy)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, "..");

function getPiExtensionDir() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) {
    return null;
  }

  // Pi's global extension directory
  const piDir = process.env.PI_EXTENSIONS_DIR ||
    path.join(home, ".pi", "agent", "extensions");

  return piDir;
}

function log(msg) {
  console.log(`[pi-multi-agent] ${msg}`);
}

function warn(msg) {
  console.warn(`[pi-multi-agent] ⚠ ${msg}`);
}

function success(msg) {
  console.log(`[pi-multi-agent] ✓ ${msg}`);
}

async function install() {
  const extDir = getPiExtensionDir();
  if (!extDir) {
    warn("Could not determine pi extension directory. Skipping auto-install.");
    warn("To install manually, create a symlink to the extension directory.");
    return;
  }

  const targetDir = path.join(extDir, "pi-multi-agent");

  try {
    // Create extension directory
    fs.mkdirSync(targetDir, { recursive: true });
    log(`Installing to: ${targetDir}`);

    // Copy source files (preserving src/ subdirectory)
    const srcDir = path.join(PKG_ROOT, "src");
    const targetSrcDir = path.join(targetDir, "src");
    fs.mkdirSync(targetSrcDir, { recursive: true });

    const filesToCopy = ["index.ts", "config.ts", "orchestrator.ts", "types.ts"];

    for (const file of filesToCopy) {
      const srcPath = path.join(srcDir, file);
      const destPath = path.join(targetSrcDir, file);

      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, destPath);
        log(`  Copied: src/${file}`);
      } else {
        warn(`  Source file not found: ${srcPath}`);
      }
    }

    // Copy package.json for dependency resolution
    const pkgDest = path.join(targetDir, "package.json");
    fs.copyFileSync(path.join(PKG_ROOT, "package.json"), pkgDest);

    // Check if node_modules needs to be set up
    const localNodeModules = path.join(PKG_ROOT, "node_modules");
    const targetNodeModules = path.join(targetDir, "node_modules");

    if (fs.existsSync(localNodeModules)) {
      // Check if node_modules already exists at target
      let targetNodeModulesExists = false;
      try {
        targetNodeModulesExists = fs.existsSync(targetNodeModules);
      } catch {}

      if (!targetNodeModulesExists) {
        try {
          if (process.platform === "win32") {
            // On Windows, use junction
            try {
              fs.symlinkSync(localNodeModules, targetNodeModules, "junction");
              log("  Created node_modules junction");
            } catch (err) {
              warn(`Could not create junction: ${err.message}`);
              warn("  node_modules: not linked, but local node_modules will be used");
            }
          } else {
            fs.symlinkSync(localNodeModules, targetNodeModules);
            log("  Created node_modules symlink");
          }
        } catch (err) {
          warn(`  Could not link node_modules: ${err.message}`);
          warn(`  Run: cd "${targetDir}" && npm install`);
        }
      } else {
        log("  node_modules link already exists");
      }
    } else {
      warn("  No node_modules found locally. Run npm install in the target dir if needed.");
    }

    success(`Extension installed to ${targetDir}`);
    log("");
    log("To use the extension:");
    log("  1. Restart pi (or run /reload in a pi session)");
    log("  2. Run /multi-agent (or /ma) to configure models and API key");
    log("  3. Ask the LLM to use multi_agent tool for complex tasks");
    log("");

  } catch (err) {
    warn(`Installation failed: ${err.message}`);
    warn("To install manually:");
    warn(`  mkdir -p "${extDir}/pi-multi-agent"`);
    warn(`  cp -r src/* "${extDir}/pi-multi-agent/"`);
    warn(`  cd "${extDir}/pi-multi-agent" && npm install`);
  }
}

install().catch((err) => {
  console.error(`[pi-multi-agent] Error: ${err.message}`);
});
