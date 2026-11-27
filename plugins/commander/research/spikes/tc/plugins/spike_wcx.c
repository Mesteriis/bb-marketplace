/* spike.wcx: synthetic archive (any existing file opens as an archive with 3 fixed entries).
 * Built: clang -shared -arch arm64 -fvisibility=hidden -o spike.wcx spike_wcx.c */
#include "tc_types.h"
#include <stdio.h>
#include <unistd.h>

typedef int (*ProcessDataProcW)(const WCHAR *, int);
typedef int (*ChangeVolProcW)(const WCHAR *, int);

enum { E_END_ARCHIVE = 10, E_EOPEN = 15, E_ECREATE = 16, E_EWRITE = 19, E_EABORTED = 21, E_NOT_SUPPORTED = 24 };
enum { PK_SKIP = 0, PK_TEST = 1, PK_EXTRACT = 2 };

/* FileTime = (2024-1980)<<25 | 3<<21 | 5<<16 | 12<<11 | 30<<5 | 10/2 */
#define DOSTIME ((44u << 25) | (3u << 21) | (5u << 16) | (12u << 11) | (30u << 5) | 5u)
typedef struct { const char *name; unsigned pack_hi, pack_lo, unp_hi, unp_lo; int crc; const unsigned char *data; size_t len; } Entry;
#define S(x) ((const unsigned char *)(x)), (sizeof(x) - 1)
static const Entry ENTRIES[] = {
  {"hello.txt", 0, 15, 0, 15, 0x1111, S("Hello from WCX\n")},
  {"каталог\\Привет 😀.txt", 0, 13, 0, 13, 0x2222, S("Привет\n")},
  {"big.bin", 1, 0, 1, 2147483648u, 0x3333, NULL, 0}, /* unpacked 6442450944 bytes, metadata only */
};
#define NENT (sizeof(ENTRIES) / sizeof(ENTRIES[0]))

typedef struct { int mode; size_t idx; ProcessDataProcW pd; ChangeVolProcW cv; } Arc;
static int g_open = 0, g_ansi = 0;

EXPORT HANDLE OpenArchiveW(tOpenArchiveDataW *d) {
  char p[1100];
  if (w_to_utf8(d->ArcName, p, sizeof p) || access(p, R_OK) != 0) { d->OpenResult = E_EOPEN; return NULL; }
  Arc *a = calloc(1, sizeof *a); a->mode = d->OpenMode; d->OpenResult = 0; g_open++;
  return a;
}
EXPORT int ReadHeaderExW(HANDLE h, tHeaderDataExW *hd) {
  Arc *a = h;
  if (a->idx >= NENT) return E_END_ARCHIVE;
  const Entry *e = &ENTRIES[a->idx++];
  utf8_to_w(e->name, hd->FileName, 1024);
  hd->PackSize = e->pack_lo; hd->PackSizeHigh = e->pack_hi; hd->UnpSize = e->unp_lo; hd->UnpSizeHigh = e->unp_hi;
  hd->FileCRC = e->crc; hd->FileTime = (int)DOSTIME; hd->FileAttr = 0x20;
  return 0;
}
static int tick(Arc *a, const Entry *e, size_t n) {
  if (!a->pd) return 1;
  WCHAR w[1024]; utf8_to_w(e->name, w, 1024);
  return a->pd(w, (int)n);
}
EXPORT int ProcessFileW(HANDLE h, int op, const WCHAR *dest_path, const WCHAR *dest_name) {
  Arc *a = h; const Entry *e = &ENTRIES[a->idx - 1];
  if (op == PK_SKIP) return 0;
  if (!e->data) return E_NOT_SUPPORTED;
  size_t half = e->len / 2;
  if (op == PK_TEST) { if (!tick(a, e, half) || !tick(a, e, e->len - half)) return E_EABORTED; return 0; }
  char dn[1100] = "", dp[1100] = "", out[2300], part[2400];
  if (!dest_name || w_to_utf8(dest_name, dn, sizeof dn)) return E_ECREATE;
  if (dest_path && *dest_path) { if (w_to_utf8(dest_path, dp, sizeof dp)) return E_ECREATE; snprintf(out, sizeof out, "%s/%s", dp, dn); }
  else snprintf(out, sizeof out, "%s", dn);
  snprintf(part, sizeof part, "%s.part", out);
  FILE *fp = fopen(part, "wb"); if (!fp) return E_ECREATE;
  if (fwrite(e->data, 1, half, fp) != half) { fclose(fp); remove(part); return E_EWRITE; }
  if (!tick(a, e, half)) { fclose(fp); remove(part); return E_EABORTED; }
  if (fwrite(e->data + half, 1, e->len - half, fp) != e->len - half) { fclose(fp); remove(part); return E_EWRITE; }
  if (fclose(fp) || rename(part, out)) { remove(part); return E_EWRITE; }
  if (!tick(a, e, e->len - half)) { remove(out); return E_EABORTED; }
  return 0;
}
EXPORT int CloseArchive(HANDLE h) { if (h) { free(h); g_open--; } return 0; }
EXPORT void SetProcessDataProcW(HANDLE h, ProcessDataProcW p) { if (h) ((Arc *)h)->pd = p; }
EXPORT void SetChangeVolProcW(HANDLE h, ChangeVolProcW p) { if (h) ((Arc *)h)->cv = p; }
EXPORT int GetPackerCaps(void) { return 4 | 64; } /* PK_CAPS_MULTIPLE | PK_CAPS_BY_CONTENT; no NEW/MODIFY => read-only */
EXPORT int GetBackgroundFlags(void) { return 0; }

/* ANSI stubs: count calls so tests can prove the W path was used */
EXPORT HANDLE OpenArchive(void *d) { (void)d; g_ansi++; return NULL; }
EXPORT int ReadHeader(HANDLE h, void *hd) { (void)h; (void)hd; g_ansi++; return E_NOT_SUPPORTED; }
EXPORT int ReadHeaderEx(HANDLE h, void *hd) { (void)h; (void)hd; g_ansi++; return E_NOT_SUPPORTED; }
EXPORT int ProcessFile(HANDLE h, int op, char *dp, char *dn) { (void)h; (void)op; (void)dp; (void)dn; g_ansi++; return E_NOT_SUPPORTED; }

EXPORT int SpikeOpenArchives(void) { return g_open; }
EXPORT int SpikeAnsiCalls(void) { return g_ansi; }
EXPORT long SpikeLayout(const char *k) {
#define L(name, val) if (!strcmp(k, name)) return (long)(val);
#define HF(T, P) \
  L(P ".size", sizeof(T)) L(P ".Flags", offsetof(T, Flags)) L(P ".PackSize", offsetof(T, PackSize)) L(P ".PackSizeHigh", offsetof(T, PackSizeHigh)) \
  L(P ".UnpSize", offsetof(T, UnpSize)) L(P ".UnpSizeHigh", offsetof(T, UnpSizeHigh)) L(P ".HostOS", offsetof(T, HostOS)) L(P ".FileCRC", offsetof(T, FileCRC)) \
  L(P ".FileTime", offsetof(T, FileTime)) L(P ".UnpVer", offsetof(T, UnpVer)) L(P ".Method", offsetof(T, Method)) L(P ".FileAttr", offsetof(T, FileAttr)) \
  L(P ".CmtBuf", offsetof(T, CmtBuf)) L(P ".CmtBufSize", offsetof(T, CmtBufSize)) L(P ".CmtSize", offsetof(T, CmtSize)) L(P ".CmtState", offsetof(T, CmtState)) \
  L(P ".Reserved", offsetof(T, Reserved))
  HF(tHeaderDataExW, "tHeaderDataExW") HF(tHeaderDataExW_packed, "tHeaderDataExW.packed")
  HF(tHeaderDataEx, "tHeaderDataEx") HF(tHeaderDataEx_packed, "tHeaderDataEx.packed")
  L("tOpenArchiveDataW.size", sizeof(tOpenArchiveDataW)) L("tOpenArchiveDataW.OpenMode", offsetof(tOpenArchiveDataW, OpenMode))
  L("tOpenArchiveDataW.OpenResult", offsetof(tOpenArchiveDataW, OpenResult)) L("tOpenArchiveDataW.CmtBuf", offsetof(tOpenArchiveDataW, CmtBuf))
  L("tOpenArchiveDataW.packed.size", sizeof(tOpenArchiveDataW_packed))
  return -1;
}
