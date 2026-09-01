import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { reportOutputAncestors } from './report.js';

export function reportOutput(workspaceRoot: string, value: string | undefined, runId: string) {
  const root = resolve(workspaceRoot);
  const requested = value ?? `.hound/reports/${runId}.html`;
  if (isAbsolute(requested) || !requested.endsWith('.html') || requested.split(/[\\/]/).some(part => part === '..' || part === '.')) throw new Error('invalid_output_path');
  const output = resolve(root, requested); const within = relative(root, output);
  if (!within || within.startsWith(`..${sep}`) || within === '..') throw new Error('invalid_output_path');
  return output;
}

export async function writeHtml(workspaceRoot: string, path: string, html: string) {
  const root = resolve(workspaceRoot); const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  for (const directory of reportOutputAncestors(root, path)) {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('unsafe_output_directory');
  }
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('unsafe_output_file');
  } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}.tmp`; const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(html); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}
