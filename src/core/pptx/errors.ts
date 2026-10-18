export type PptxErrorCode =
  | 'NOT_A_ZIP'
  | 'LEGACY_PPT'
  | 'ENCRYPTED'
  | 'NOT_PPTX'
  | 'FILE_TOO_LARGE'
  | 'ZIP_TOO_MANY_ENTRIES'
  | 'ZIP_ENTRY_TOO_LARGE'
  | 'ZIP_TOTAL_TOO_LARGE'
  | 'ZIP_RATIO_SUSPICIOUS'
  | 'ZIP_BAD_ENTRY'
  | 'ZIP_UNSUPPORTED'
  | 'ZIP_DUPLICATE_ENTRY'
  | 'ZIP_OVERLAP'
  | 'ZIP_SIZE_MISMATCH'
  | 'ZIP_CRC_MISMATCH'
  | 'XML_FORBIDDEN_DTD'
  | 'XML_TOO_LARGE'
  | 'XML_MALFORMED'
  | 'TOO_MANY_SLIDES';

/** Error raised for any file that is rejected as unsafe, unsupported or corrupt. */
export class PptxError extends Error {
  readonly code: PptxErrorCode;

  constructor(code: PptxErrorCode, message: string) {
    super(message);
    this.name = 'PptxError';
    this.code = code;
  }
}

/** User-facing explanation for a rejected file. */
export function describePptxError(err: unknown): string {
  if (err instanceof PptxError) {
    switch (err.code) {
      case 'LEGACY_PPT':
        return 'This is an old .ppt file. Open it in PowerPoint and use Save As → PowerPoint Presentation (.pptx), then upload that.';
      case 'ENCRYPTED':
        return 'This presentation is password-protected. Remove the password in PowerPoint (File → Info → Protect Presentation) and save a copy.';
      case 'NOT_A_ZIP':
      case 'NOT_PPTX':
        return 'This file is not a valid .pptx presentation.';
      case 'FILE_TOO_LARGE':
        return 'This file is larger than the safety limit for in-browser processing.';
      default:
        return `This file was rejected for safety or integrity reasons (${err.code}): ${err.message}`;
    }
  }
  return err instanceof Error ? err.message : 'Unknown error while reading the file.';
}
