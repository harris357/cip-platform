// Slice 58C-FIX — coarse MIME → extractor class.
//
// Maps the wire MIME (or filename extension when MIME is a placeholder
// like 'application/octet-stream' or Teams' synthetic
// 'application/vnd.microsoft.teams.file.download.info') to one of the
// six extractor classes the doc-service supports + 'unsupported'.
//
// Mirrors teams-bot's guessMimeType() pattern: trust a real MIME if the
// caller supplied one, otherwise fall back to filename extension.
//
// Legacy office formats (.doc / .xls / .ppt) classify as 'unsupported'
// — the user-facing error message tells the uploader to convert to the
// modern OOXML variants. We deliberately don't chase libreoffice-convert
// or similar heavyweight conversion stacks (kickoff hard rule #4).

export type MimeClass =
  | 'pdf'
  | 'image'
  | 'plain_text'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'unsupported'

const PLACEHOLDER_MIMES = new Set<string>([
  '',
  'application/octet-stream',
  // Teams synthetic content types — see teams-bot/file-handler.ts.
  'application/vnd.microsoft.teams.file.download.info',
])

const TEXT_EXTENSIONS  = new Set(['txt', 'md', 'csv', 'log', 'tsv', 'json', 'yaml', 'yml'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'tiff', 'tif', 'bmp', 'heic', 'heif'])

export function classifyMime(mimeType: string | null | undefined, fileName?: string | null): MimeClass {
  const m = (mimeType ?? '').trim().toLowerCase()

  // 1. Trust a real MIME first.
  if (!PLACEHOLDER_MIMES.has(m)) {
    if (m === 'application/pdf') return 'pdf'
    if (m.startsWith('image/'))  return 'image'

    // Plain text family (incl. text/markdown, text/csv, text/plain, ...).
    if (m.startsWith('text/')) return 'plain_text'
    // Some uploaders send application/json or application/x-yaml as
    // text-shaped content. Treat them as plain_text — they're UTF-8.
    if (m === 'application/json' || m === 'application/x-yaml' || m === 'application/yaml') return 'plain_text'

    if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx'
    if (m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')        return 'xlsx'
    if (m === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx'

    // Legacy office binaries: classified as 'unsupported' — extractor
    // dispatcher throws a clear ApplicationFailure.
    if (m === 'application/msword'                  ||
        m === 'application/vnd.ms-excel'            ||
        m === 'application/vnd.ms-powerpoint') {
      return 'unsupported'
    }
    // Any other concrete MIME we don't recognise — fall through to
    // extension-based detection (some uploaders mislabel modern OOXML
    // as application/zip when sniffing magic bytes loosely).
  }

  // 2. Fall back to filename extension.
  const ext = (fileName ?? '').split('.').pop()?.toLowerCase() ?? ''

  if (ext === 'pdf')  return 'pdf'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (TEXT_EXTENSIONS.has(ext))  return 'plain_text'
  if (ext === 'docx') return 'docx'
  if (ext === 'xlsx') return 'xlsx'
  if (ext === 'pptx') return 'pptx'

  // Legacy office extensions — surface the same explicit unsupported
  // signal as the legacy MIME branch above.
  if (ext === 'doc' || ext === 'xls' || ext === 'ppt') return 'unsupported'

  return 'unsupported'
}
