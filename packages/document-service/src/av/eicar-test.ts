// EICAR is the industry-standard "fake virus" — 68 bytes of ASCII
// every AV engine agrees should trigger detection.  Used by
// test/av-integration.test.ts to verify the wiring without shipping
// real malware.
//
// https://www.eicar.org/download-anti-malware-testfile/

export const EICAR_TEST_STRING =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'

export function eicarBuffer(): Buffer {
  return Buffer.from(EICAR_TEST_STRING, 'utf-8')
}
