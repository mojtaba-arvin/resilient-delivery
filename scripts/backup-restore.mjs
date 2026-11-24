import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function syncFile(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicCopy(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp`;
  await rm(temporary, { force: true });
  try {
    await pipeline(createReadStream(source), createWriteStream(temporary, { flags: "wx" }));
    await syncFile(temporary);
    await rename(temporary, destination);
    await syncDirectory(dirname(destination));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function backupDatabase(sourcePath, backupPath) {
  const source = resolve(sourcePath);
  const backup = resolve(backupPath);
  if (source === backup) throw new Error("Backup destination must differ from the source database");
  if (!(await stat(source)).isFile()) throw new Error("Source database must be a regular file");
  await atomicCopy(source, backup);
  const sha256 = await digest(backup);
  const manifestPath = `${backup}.sha256`;
  const temporaryManifest = `${manifestPath}.tmp`;
  await rm(temporaryManifest, { force: true });
  const handle = await open(temporaryManifest, "wx");
  try {
    await handle.writeFile(`${sha256}  ${backup.split(/[\\/]/).pop()}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporaryManifest, manifestPath);
  await syncDirectory(dirname(backup));
  return { backup, sha256, manifestPath };
}

export async function restoreDatabase(backupPath, destinationPath) {
  const backup = resolve(backupPath);
  const destination = resolve(destinationPath);
  if (backup === destination) throw new Error("Restore source and destination must differ");
  const expected = (await readFile(`${backup}.sha256`, "utf8")).trim().split(/\s+/)[0];
  const actual = await digest(backup);
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) {
    throw new Error("Backup SHA-256 verification failed; destination was not changed");
  }
  await atomicCopy(backup, destination);
  return { destination, sha256: actual };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, source, destination] = process.argv.slice(2);
  if (!["backup", "restore"].includes(command) || !source || !destination) {
    process.stderr.write("Usage: node scripts/backup-restore.mjs <backup|restore> <source> <destination>\n");
    process.exitCode = 2;
  } else {
    const operation = command === "backup" ? backupDatabase : restoreDatabase;
    operation(source, destination)
      .then(result => process.stdout.write(JSON.stringify(result, null, 2) + "\n"))
      .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  }
}
