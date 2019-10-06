#!/usr/bin/env deno --allow-write --allow-read --allow-net
import * as path from "./vendor/https/deno.land/std/fs/path.ts";
import * as fs from "./vendor/https/deno.land/std/fs/mod.ts";
import * as flags from "./vendor/https/deno.land/std/flags/mod.ts";
import { gray, green, red } from "./vendor/https/deno.land/std/fmt/colors.ts";

export type Module = {
  version: string;
  modules: string[];
};
export type Modules = {
  [key: string]: Module;
};

function isDinkModules(x, errors: string[]): x is Modules {
  if (typeof x !== "object") {
    errors.push("is not object");
    return false;
  }
  for (const k in x) {
    if (x.hasOwnProperty(k)) {
      const m = x[k];
      if (typeof m["version"] !== "string") {
        errors.push('"version" must be string');
        return false;
      }
      if (!Array.isArray(m["modules"])) {
        errors.push(`\"modules\" must be array`);
        return false;
      }
      for (const mod of m["modules"]) {
        if (typeof mod !== "string") {
          errors.push(`"content of "modules" must be string`);
          return false;
        }
      }
    }
  }
  return true;
}

async function deleteRemovedFiles(modules: Modules, lockFile: Modules) {
  const removedFiles: string[] = [];
  for (const [k, v] of Object.entries(lockFile)) {
    const url = new URL(k);
    const { protocol, hostname, pathname } = url;
    const scheme = protocol.slice(0, protocol.length - 1);
    const dir = path.join("./vendor", scheme, hostname, pathname);
    if (!modules[k]) {
      for (const i of v.modules) {
        removedFiles.push(path.join(dir, i));
      }
    } else {
      const mod = modules[k];
      const set = new Set<string>(v.modules);
      mod.modules.forEach(i => set.delete(i));
      for (const i of set.values()) {
        removedFiles.push(path.join(dir, i));
      }
    }
  }
  await Promise.all(
    removedFiles.map(async i => {
      if (!(await fs.exists(i))) {
        return;
      }
      await Deno.remove(i);
      let dir = path.dirname(i);
      while ((await Deno.readDir(dir)).length === 0) {
        await Deno.remove(dir);
        dir = path.dirname(dir);
      }
      console.log(`${red("Removed")}: ./${i}`);
    })
  );
}
const encoder = new TextEncoder();

async function ensure(modules: Modules) {
  const lockFile = await readLockFile();
  await deleteRemovedFiles(modules, lockFile);
  for (const [host, v] of Object.entries(modules)) {
    await Promise.all(
      v.modules.map(writeLinkFile({ host, version: v.version, lockFile }))
    );
    await generateLockFile(modules);
  }
}

function writeLinkFile({
  host,
  version,
  lockFile
}: {
  host: string;
  version: string;
  lockFile: Modules;
}): (mod: string) => Promise<void> {
  return async (mod: string) => {
    const url = new URL(host);
    const { protocol, hostname, pathname } = url;
    const scheme = protocol.slice(0, protocol.length - 1);
    const dir = path.join("./vendor", scheme, hostname, pathname);
    const modFile = path.join(dir, mod);
    const modDir = path.dirname(modFile);
    let lockedVersion = version;
    if (lockFile && lockFile[host] && lockFile[host].version) {
      lockedVersion = lockFile[host].version;
    }
    const specifier = `${host}${version}${mod}`;
    const hasLink = await fs.exists(modFile);
    if (hasLink && version === lockedVersion) {
      console.log(gray(`Linked: ${specifier} -> ./${modFile}`));
      return;
    }
    const resp = await fetch(specifier, { method: "GET" });
    if (resp.status !== 200) {
      throw new Error(`failed to fetch metadata for ${specifier}`);
    }
    const contentLength = parseInt(resp.headers.get("content-length") || "0");
    if (contentLength > 10000000) {
      throw new Error(`too big source file: ${contentLength}bytes`);
    }
    const code = await resp.text();
    // Roughly search for export default declaration
    const hasDefaultExport = !!code.match(/export[\s\t]*default[\s\t]/);
    let link = `export * from "${resp.url}";\n`;
    if (hasDefaultExport) {
      link += `import {default as dew} from "${resp.url}";\n`;
      link += `export default dew;\n`;
    }
    await Deno.mkdir(modDir, true);
    const f = await Deno.open(modFile, "w");
    try {
      await Deno.write(f.rid, encoder.encode(link));
    } finally {
      f.close();
    }
    console.log(`${green("Linked")}: ${specifier} -> ./${modFile}`);
  };
}

async function generateLockFile(modules: Modules) {
  const obj = new TextEncoder().encode(JSON.stringify(modules, null, "  "));
  await Deno.writeFile("./modules-lock.json", obj);
}

async function readLockFile(): Promise<Modules | undefined> {
  if (await fs.exists("./modules-lock.json")) {
    const f = await Deno.readFile("./modules-lock.json");
    const lock = JSON.parse(new TextDecoder().decode(f));
    const err = [];
    if (!isDinkModules(lock, err)) {
      throw new Error(
        "lock file may be saved as invalid format: " + err.join(",")
      );
    }
    return lock;
  }
}

const VERSION = "0.6.0";

type DinkOptions = {
  file?: string;
};

async function main() {
  const args = flags.parse(Deno.args, {
    alias: {
      h: "help",
      V: "ver"
    },
    "--": true
  });
  if (args["V"] || args["ver"]) {
    console.log(VERSION);
    Deno.exit(0);
  }
  if (args["h"] || args["help"]) {
    console.log(
      String(`
    USAGE

      dink (just type ${green("dink")})

    ARGUMENTS

    OPTIONS
   
      -f, --file         Custom path for module.json  (Optional)         
       
    GLOBAL OPTIONS
    
      -h, --help         Display help
      -V, --ver          Display version
         
    `)
    );
    Deno.exit(0);
  }
  const opts: DinkOptions = {
    file: "./modules.json"
  };
  if (args["f"]) {
    opts.file = args["f"];
  }
  if (!(await fs.exists(opts.file))) {
    console.error(`${opts.file} does not exists`);
    Deno.exit(1);
  }
  const file = await Deno.readFile(opts.file);
  const decoder = new TextDecoder();
  const json = JSON.parse(decoder.decode(file)) as Modules;
  const errors = [];
  if (!isDinkModules(json, errors)) {
    console.error(`${opts.file} has syntax error: ${errors.join(",")}`);
    Deno.exit(1);
  }
  await ensure(json);
  Deno.exit(0);
}

main();
