/* spike.wfx: in-memory virtual file system speaking the TC WFX contract.
 * Built: clang -shared -arch arm64 -fvisibility=hidden -o spike.wfx spike_wfx.c */
#include "tc_types.h"
#include <stdio.h>
#include <errno.h>
#include <unistd.h>
#include <signal.h>

typedef int (*ProgressProcW)(int, const WCHAR *, const WCHAR *, int);
typedef void (*LogProcW)(int, int, const WCHAR *);
typedef int (*RequestProcW)(int, int, const WCHAR *, const WCHAR *, WCHAR *, int);

static int g_nr = 0;
static ProgressProcW g_progress; static LogProcW g_log; static RequestProcW g_request;
static int g_open_handles = 0, g_ansi_calls = 0;

#define ATTR_DIR 0x10u
#define ATTR_FILE 0x80u /* FILE_ATTRIBUTE_NORMAL */
#define UNIX_FLAG 0x80000000u
typedef struct { const char *dir, *name; DWORD attr, hi, lo, mode; const unsigned char *data; size_t len; } Node;
static const unsigned char EMOJI[4] = {0xDE, 0xAD, 0xBE, 0xEF};
#define S(x) ((const unsigned char *)(x)), (sizeof(x) - 1)
static const Node NODES[] = {
  {"\\", "readme.txt", ATTR_FILE | UNIX_FLAG, 0, 11, 0100644, S("Hello, TC!\n")},
  {"\\", "Привет.txt", ATTR_FILE, 0, 22, 0, S("Привет, мир!\n")},
  {"\\", "😀 emoji.bin", ATTR_FILE, 0, 4, 0, EMOJI, 4},
  {"\\", "subdir", ATTR_DIR, 0, 0, 0, NULL, 0},
  {"\\", "huge.bin", ATTR_FILE, 1, 1073741824u, 0, NULL, 0}, /* 5368709120 bytes, metadata only */
  {"\\subdir", "inner.txt", ATTR_FILE, 0, 6, 0, S("inner\n")},
  {"\\subdir", "nested", ATTR_DIR, 0, 0, 0, NULL, 0},
  {"\\subdir\\nested", "deep.txt", ATTR_FILE, 0, 5, 0, S("deep\n")},
};
#define NNODES (sizeof(NODES) / sizeof(NODES[0]))

typedef struct { char dir[1100]; size_t idx; int bad; } Find;

static void logmsg(int type, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
#include <stdarg.h>
static void logmsg(int type, const char *fmt, ...) {
  if (!g_log) return;
  char buf[512]; WCHAR w[512]; va_list ap; va_start(ap, fmt); vsnprintf(buf, sizeof buf, fmt, ap); va_end(ap);
  if (utf8_to_w(buf, w, 512) == 0) g_log(g_nr, type, w);
}

static int dir_exists(const char *path) {
  if (!strcmp(path, "\\")) return 1;
  for (size_t i = 0; i < NNODES; i++) if (NODES[i].attr & ATTR_DIR) {
    char full[1100]; snprintf(full, sizeof full, "%s%s%s", NODES[i].dir, strcmp(NODES[i].dir, "\\") ? "\\" : "", NODES[i].name);
    if (!strcmp(full, path)) return 1;
  }
  return 0;
}
static const Node *find_file(const char *path) {
  for (size_t i = 0; i < NNODES; i++) {
    char full[1100]; snprintf(full, sizeof full, "%s%s%s", NODES[i].dir, strcmp(NODES[i].dir, "\\") ? "\\" : "", NODES[i].name);
    if (!strcmp(full, path)) return &NODES[i];
  }
  return NULL;
}
static void fill(WIN32_FIND_DATAW *fd, const Node *n) {
  memset(fd, 0, sizeof *fd);
  fd->dwFileAttributes = n->attr; fd->dwReserved0 = n->mode;
  fd->nFileSizeHigh = n->hi; fd->nFileSizeLow = n->lo;
  if (n->hi == 1) { fd->ftLastWriteTime.dwHighDateTime = 0xFFFFFFFFu; fd->ftLastWriteTime.dwLowDateTime = 0xFFFFFFFEu; } /* "no time" */
  else { uint64_t ft = 133541154100000000ull; fd->ftLastWriteTime.dwHighDateTime = (DWORD)(ft >> 32); fd->ftLastWriteTime.dwLowDateTime = (DWORD)ft; }
  utf8_to_w(n->name, fd->cFileName, MAX_PATH);
}
static int next_match(Find *f) {
  while (f->idx < NNODES) { if (!strcmp(NODES[f->idx].dir, f->dir)) return 1; f->idx++; }
  return 0;
}

/* ---- WFX exports (W) ---- */
EXPORT int FsInitW(int nr, ProgressProcW p, LogProcW l, RequestProcW r) { g_nr = nr; g_progress = p; g_log = l; g_request = r; logmsg(7, "spike.wfx initialised, plugin %d", nr); return 0; }
EXPORT void FsSetDefaultParams(FsDefaultParamStruct *dps) {
  logmsg(7, "defaults size=%d ver=%u.%u ini=%s", dps->size, dps->PluginInterfaceVersionHi, dps->PluginInterfaceVersionLow, dps->DefaultIniName);
}
EXPORT void FsGetDefRootName(char *out, int maxlen) { snprintf(out, (size_t)maxlen, "Spike VFS"); }
EXPORT int FsGetBackgroundFlags(void) { return 0; }

EXPORT HANDLE FsFindFirstW(const WCHAR *path, WIN32_FIND_DATAW *fd) {
  char p[1100];
  if (w_to_utf8(path, p, sizeof p) != 0) { errno = EILSEQ; return INVALID_HANDLE_VALUE; }
  if (!strcmp(p, "\\crash")) abort();
  if (!strcmp(p, "\\segv")) { *(volatile int *)0 = 1; }
  if (!strcmp(p, "\\empty")) { errno = 18; return INVALID_HANDLE_VALUE; } /* convention under test: ERROR_NO_MORE_FILES = 18 */
  Find *f = calloc(1, sizeof *f);
  if (!strcmp(p, "\\badnames")) {
    f->bad = 1; memset(fd, 0, sizeof *fd);
    WCHAR bad[] = {'b', 'a', 'd', 0xD800, 'x', 0}; memcpy(fd->cFileName, bad, sizeof bad);
  } else {
    if (!dir_exists(p)) { free(f); errno = ENOENT; return INVALID_HANDLE_VALUE; }
    snprintf(f->dir, sizeof f->dir, "%s", p);
    if (!next_match(f)) { free(f); errno = 18; return INVALID_HANDLE_VALUE; }
    fill(fd, &NODES[f->idx]);
  }
  g_open_handles++;
  return f;
}
EXPORT int FsFindNextW(HANDLE h, WIN32_FIND_DATAW *fd) {
  Find *f = h;
  if (f->bad) return 0;
  f->idx++;
  if (!next_match(f)) return 0;
  fill(fd, &NODES[f->idx]); return 1;
}
EXPORT int FsFindClose(HANDLE h) { if (h && h != INVALID_HANDLE_VALUE) { free(h); g_open_handles--; } return 0; }

EXPORT int FsGetFileW(const WCHAR *remote, const WCHAR *local, int flags, RemoteInfoStruct *ri) {
  (void)ri;
  char r[1100], l[1100];
  if (w_to_utf8(remote, r, sizeof r) || w_to_utf8(local, l, sizeof l)) return 2;
  const Node *n = find_file(r);
  if (!n || (n->attr & ATTR_DIR)) return 2;           /* FS_FILE_NOTFOUND */
  if (!n->data) return 6;                              /* FS_FILE_NOTSUPPORTED (metadata-only entry) */
  int exists = access(l, F_OK) == 0;
  if (exists && (flags & 2)) return 6;                 /* resume not supported */
  if (exists && !(flags & 1)) return 1;                /* FS_FILE_EXISTS (first stage) */
  if (g_progress && g_progress(g_nr, remote, local, 0)) return 5; /* FS_FILE_USERABORT before creating anything */
  char part[1200]; snprintf(part, sizeof part, "%s.part", l);
  FILE *fp = fopen(part, "wb"); if (!fp) return 4;
  size_t half = n->len / 2;
  if (fwrite(n->data, 1, half, fp) != half) { fclose(fp); remove(part); return 4; }
  if (g_progress && g_progress(g_nr, remote, local, 50)) { fclose(fp); remove(part); return 5; }
  if (fwrite(n->data + half, 1, n->len - half, fp) != n->len - half) { fclose(fp); remove(part); return 4; }
  if (fclose(fp)) { remove(part); return 4; }
  if (rename(part, l)) { remove(part); return 4; }
  if (g_progress) g_progress(g_nr, remote, local, 100);
  return 0;
}

/* ---- ANSI variants: stubs that count calls, so a test can prove the W path was chosen ---- */
EXPORT int FsInit(int nr, void *p, void *l, void *r) { (void)nr; (void)p; (void)l; (void)r; g_ansi_calls++; return 0; }
EXPORT HANDLE FsFindFirst(const char *path, WIN32_FIND_DATAA *fd) { (void)path; (void)fd; g_ansi_calls++; errno = ENOSYS; return INVALID_HANDLE_VALUE; }
EXPORT int FsFindNext(HANDLE h, WIN32_FIND_DATAA *fd) { (void)h; (void)fd; g_ansi_calls++; return 0; }
EXPORT int FsGetFile(const char *r, const char *l, int f, RemoteInfoStruct *ri) { (void)r; (void)l; (void)f; (void)ri; g_ansi_calls++; return 6; }

/* ---- spike-only helpers ---- */
EXPORT int SpikeOpenHandles(void) { return g_open_handles; }
EXPORT int SpikeAnsiCalls(void) { return g_ansi_calls; }
EXPORT void SpikeCrash(void) { abort(); }
EXPORT long SpikeLayout(const char *k) {
#define L(name, val) if (!strcmp(k, name)) return (long)(val);
  L("WIN32_FIND_DATAW.size", sizeof(WIN32_FIND_DATAW)) L("WIN32_FIND_DATAW.dwFileAttributes", offsetof(WIN32_FIND_DATAW, dwFileAttributes))
  L("WIN32_FIND_DATAW.ftCreationTime", offsetof(WIN32_FIND_DATAW, ftCreationTime)) L("WIN32_FIND_DATAW.ftLastAccessTime", offsetof(WIN32_FIND_DATAW, ftLastAccessTime))
  L("WIN32_FIND_DATAW.ftLastWriteTime", offsetof(WIN32_FIND_DATAW, ftLastWriteTime)) L("WIN32_FIND_DATAW.nFileSizeHigh", offsetof(WIN32_FIND_DATAW, nFileSizeHigh))
  L("WIN32_FIND_DATAW.nFileSizeLow", offsetof(WIN32_FIND_DATAW, nFileSizeLow)) L("WIN32_FIND_DATAW.dwReserved0", offsetof(WIN32_FIND_DATAW, dwReserved0))
  L("WIN32_FIND_DATAW.dwReserved1", offsetof(WIN32_FIND_DATAW, dwReserved1)) L("WIN32_FIND_DATAW.cFileName", offsetof(WIN32_FIND_DATAW, cFileName))
  L("WIN32_FIND_DATAW.cAlternateFileName", offsetof(WIN32_FIND_DATAW, cAlternateFileName)) L("WIN32_FIND_DATAA.size", sizeof(WIN32_FIND_DATAA))
  L("RemoteInfoStruct.size", sizeof(RemoteInfoStruct)) L("RemoteInfoStruct.Attr", offsetof(RemoteInfoStruct, Attr))
  L("FsDefaultParamStruct.size", sizeof(FsDefaultParamStruct)) L("FsDefaultParamStruct.DefaultIniName", offsetof(FsDefaultParamStruct, DefaultIniName))
  return -1;
}
