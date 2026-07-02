import { JWT } from "google-auth-library";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
}

export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

export function driveConfigured(): boolean {
  return !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON && !!process.env.GDRIVE_CORPUS_FOLDER_ID;
}

function jwtClient(): JWT {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");
  let parsed: { client_email: string; private_key: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  return new JWT({
    email: parsed.client_email,
    key: parsed.private_key,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
}

async function accessToken(): Promise<string> {
  const { access_token } = await jwtClient().authorize();
  if (!access_token) throw new Error("Failed to obtain a Google access token");
  return access_token;
}

/** List all non-folder files in the designated corpus folder (paginated). */
export async function listCorpusFiles(): Promise<DriveFile[]> {
  const folder = process.env.GDRIVE_CORPUS_FOLDER_ID;
  if (!folder) throw new Error("GDRIVE_CORPUS_FOLDER_ID is not set");
  const token = await accessToken();

  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `'${folder}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime, size)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Drive list error ${res.status}: ${await res.text().catch(() => "")}`);
    const data = await res.json();
    for (const f of data.files || []) files.push(f as DriveFile);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return files.filter((f) => f.mimeType !== "application/vnd.google-apps.folder");
}

/** Download a file's bytes; Google Docs are exported to plain text. */
export async function downloadFile(file: DriveFile): Promise<Buffer> {
  const token = await accessToken();
  const url =
    file.mimeType === GOOGLE_DOC_MIME
      ? `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain&supportsAllDrives=true`
      : `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive download error ${res.status} for "${file.name}"`);
  return Buffer.from(await res.arrayBuffer());
}
