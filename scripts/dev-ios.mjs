import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const expoBin = join(process.cwd(), "node_modules", ".bin", "expo");
const expoCommand = existsSync(expoBin) ? expoBin : "npx";
const expoArgs = existsSync(expoBin) ? ["start", "--ios", "--clear"] : ["expo", "start", "--ios", "--clear"];

const children = [];

function run(name, command, args) {
  const child = spawn(command, args, {
    env: process.env,
    stdio: "inherit"
  });

  children.push(child);

  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.log(`${name} termino con codigo ${code}`);
    }
    if (name === "expo" && code && code !== 0) {
      stopAll();
      process.exit(code);
    }
  });

  return child;
}

function stopAll() {
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGINT");
    }
  }
}

function runQuiet(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function pickAvailableIphoneSimulator() {
  const result = runQuiet("xcrun", ["simctl", "list", "devices", "available", "--json"]);

  if (result.status !== 0) {
    return null;
  }

  const data = JSON.parse(result.stdout);
  const devices = Object.values(data.devices || {}).flat();
  return devices.find((device) => device.name?.includes("iPhone")) || devices[0] || null;
}

function prepareIosSimulator() {
  const device = pickAvailableIphoneSimulator();

  if (!device?.udid) {
    console.log("No encontre simuladores iOS disponibles. Abre Xcode y revisa Simulator.");
    return;
  }

  runQuiet("defaults", ["write", "com.apple.iphonesimulator", "CurrentDeviceUDID", device.udid]);
  const bootResult = runQuiet("xcrun", ["simctl", "boot", device.udid]);

  if (bootResult.status === 0 || bootResult.stderr.includes("Unable to boot device in current state")) {
    console.log(`Simulador listo: ${device.name} (${device.udid})`);
  } else {
    console.log(`No pude arrancar automaticamente ${device.name}: ${bootResult.stderr.trim()}`);
  }
}

process.on("SIGINT", () => {
  stopAll();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopAll();
  process.exit(0);
});

prepareIosSimulator();

setTimeout(() => {
  run("expo", expoCommand, expoArgs);
}, 800);
