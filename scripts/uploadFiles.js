// scripts/uploadFiles.js
//
// Helpers for scripts that store images the same way an admin upload does
// (middleware/upload.js): uploads/<subdir>/<fieldname>-<entityId>-<ts>-<rand><ext>,
// referenced as "/uploads/<subdir>/<name>". Keeping that shape means admins
// can replace these files from the admin panel like any other upload — the
// controllers delete the old file on replace, so each record owns its copy.

import fs from "fs";
import path from "path";

const uniqueSuffix = () => `${Date.now()}-${Math.round(Math.random() * 1e9)}`;

// Writes `data` (Buffer) as a new upload and returns its /uploads/... URL.
export function saveUpload(data, uploadDir, subdir, fieldname, entityId, ext) {
  const dir = path.join(uploadDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${fieldname}-${entityId}-${uniqueSuffix()}${ext.toLowerCase()}`;
  fs.writeFileSync(path.join(dir, name), data);
  return `/uploads/${subdir}/${name}`;
}

// Deletes an upload by its /uploads/... URL, never touching anything outside uploadDir.
export function removeOldUpload(url, uploadDir) {
  if (typeof url !== "string" || !url.startsWith("/uploads/")) return;
  const file = path.join(uploadDir, url.slice("/uploads/".length));
  if (path.relative(uploadDir, file).startsWith("..")) return;
  fs.unlink(file, () => {});
}

// The server serves process.cwd()/uploads (middleware/upload.js), so scripts
// writing images must run from the backend root, on the server machine.
export function serverUploadDir(backendRoot) {
  if (path.resolve(process.cwd()) !== path.resolve(backendRoot)) {
    throw new Error(`Run this from ${backendRoot} (the server serves uploads/ relative to it).`);
  }
  return path.join(backendRoot, "uploads");
}
