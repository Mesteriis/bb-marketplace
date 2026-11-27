/* Own minimal type definitions for the Commander TC-compat spike.
 * Derived from the SDK documentation (win32_find_data.htm, remoteinfostruct.htm,
 * fsdefaultparamstruct.htm, theaderdataex.htm, topenarchivedata.htm); no SDK or
 * Double Commander header text is copied. Layout is checked by sizeof/offsetof
 * tests (see tests/integration.rs). */
#ifndef TC_TYPES_H
#define TC_TYPES_H
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

#define EXPORT __attribute__((visibility("default")))

typedef uint32_t DWORD;
typedef uint16_t WCHAR;
typedef void *HANDLE;
#define INVALID_HANDLE_VALUE ((HANDLE)(intptr_t)-1)
#define MAX_PATH 260

typedef struct { DWORD dwLowDateTime, dwHighDateTime; } FILETIME;

/* pack(1) as Double Commander does on Unix (documented in tc-compat.md section 2) */
#pragma pack(push, 1)
typedef struct {
  DWORD dwFileAttributes;
  FILETIME ftCreationTime, ftLastAccessTime, ftLastWriteTime;
  DWORD nFileSizeHigh, nFileSizeLow, dwReserved0, dwReserved1;
  WCHAR cFileName[MAX_PATH];
  WCHAR cAlternateFileName[14];
} WIN32_FIND_DATAW;
typedef struct {
  DWORD dwFileAttributes;
  FILETIME ftCreationTime, ftLastAccessTime, ftLastWriteTime;
  DWORD nFileSizeHigh, nFileSizeLow, dwReserved0, dwReserved1;
  char cFileName[MAX_PATH];
  char cAlternateFileName[14];
} WIN32_FIND_DATAA;
typedef struct { DWORD SizeLow, SizeHigh; FILETIME LastWriteTime; int Attr; } RemoteInfoStruct;
typedef struct { int size; DWORD PluginInterfaceVersionLow, PluginInterfaceVersionHi; char DefaultIniName[MAX_PATH]; } FsDefaultParamStruct;
#pragma pack(pop)

/* WCX structures as the TC C header declares them: natural alignment (no pragma). */
typedef struct {
  WCHAR ArcName[1024]; WCHAR FileName[1024];
  int Flags; unsigned int PackSize, PackSizeHigh, UnpSize, UnpSizeHigh;
  int HostOS, FileCRC, FileTime, UnpVer, Method, FileAttr;
  WCHAR *CmtBuf; int CmtBufSize, CmtSize, CmtState;
  char Reserved[1024];
} tHeaderDataExW;
typedef struct {
  char ArcName[1024]; char FileName[1024];
  int Flags; unsigned int PackSize, PackSizeHigh, UnpSize, UnpSizeHigh;
  int HostOS, FileCRC, FileTime, UnpVer, Method, FileAttr;
  char *CmtBuf; int CmtBufSize, CmtSize, CmtState;
  char Reserved[1024];
} tHeaderDataEx;
typedef struct {
  WCHAR *ArcName; int OpenMode, OpenResult; WCHAR *CmtBuf; int CmtBufSize, CmtSize, CmtState;
} tOpenArchiveDataW;
/* The same, packed (Pascal `packed record` flavour used by DC) */
#pragma pack(push, 1)
typedef struct {
  WCHAR ArcName[1024]; WCHAR FileName[1024];
  int Flags; unsigned int PackSize, PackSizeHigh, UnpSize, UnpSizeHigh;
  int HostOS, FileCRC, FileTime, UnpVer, Method, FileAttr;
  WCHAR *CmtBuf; int CmtBufSize, CmtSize, CmtState;
  char Reserved[1024];
} tHeaderDataExW_packed;
typedef struct {
  char ArcName[1024]; char FileName[1024];
  int Flags; unsigned int PackSize, PackSizeHigh, UnpSize, UnpSizeHigh;
  int HostOS, FileCRC, FileTime, UnpVer, Method, FileAttr;
  char *CmtBuf; int CmtBufSize, CmtSize, CmtState;
  char Reserved[1024];
} tHeaderDataEx_packed;
typedef struct {
  WCHAR *ArcName; int OpenMode, OpenResult; WCHAR *CmtBuf; int CmtBufSize, CmtSize, CmtState;
} tOpenArchiveDataW_packed;
#pragma pack(pop)

/* ---- UTF-16 <-> UTF-8 (strict: returns -1 on lone surrogate) ---- */
static int w_to_utf8(const WCHAR *w, char *out, size_t cap) {
  size_t o = 0;
  for (size_t i = 0; w[i]; i++) {
    uint32_t c = w[i];
    if (c >= 0xD800 && c <= 0xDBFF) {
      if (w[i + 1] < 0xDC00 || w[i + 1] > 0xDFFF) return -1;
      c = 0x10000 + ((c - 0xD800) << 10) + (w[i + 1] - 0xDC00); i++;
    } else if (c >= 0xDC00 && c <= 0xDFFF) return -1;
    if (o + 5 >= cap) return -1;
    if (c < 0x80) out[o++] = (char)c;
    else if (c < 0x800) { out[o++] = (char)(0xC0 | (c >> 6)); out[o++] = (char)(0x80 | (c & 0x3F)); }
    else if (c < 0x10000) { out[o++] = (char)(0xE0 | (c >> 12)); out[o++] = (char)(0x80 | ((c >> 6) & 0x3F)); out[o++] = (char)(0x80 | (c & 0x3F)); }
    else { out[o++] = (char)(0xF0 | (c >> 18)); out[o++] = (char)(0x80 | ((c >> 12) & 0x3F)); out[o++] = (char)(0x80 | ((c >> 6) & 0x3F)); out[o++] = (char)(0x80 | (c & 0x3F)); }
  }
  out[o] = 0; return 0;
}
static int utf8_to_w(const char *s, WCHAR *out, size_t cap) {
  size_t o = 0; const unsigned char *p = (const unsigned char *)s;
  while (*p) {
    uint32_t c; int n;
    if (*p < 0x80) { c = *p; n = 1; }
    else if ((*p & 0xE0) == 0xC0) { c = *p & 0x1F; n = 2; }
    else if ((*p & 0xF0) == 0xE0) { c = *p & 0x0F; n = 3; }
    else if ((*p & 0xF8) == 0xF0) { c = *p & 0x07; n = 4; }
    else return -1;
    for (int k = 1; k < n; k++) { if ((p[k] & 0xC0) != 0x80) return -1; c = (c << 6) | (p[k] & 0x3F); }
    p += n;
    if (c >= 0x10000) {
      if (o + 2 >= cap) return -1;
      c -= 0x10000; out[o++] = (WCHAR)(0xD800 + (c >> 10)); out[o++] = (WCHAR)(0xDC00 + (c & 0x3FF));
    } else { if (o + 1 >= cap) return -1; out[o++] = (WCHAR)c; }
  }
  out[o] = 0; return 0;
}
#endif
