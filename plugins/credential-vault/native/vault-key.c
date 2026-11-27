/* The only process that calls Security.framework. Its stdout is a private pipe. */
#include <Security/Security.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define SERVICE "bb.credential-vault.master.v1"
#define KEY_BYTES 32

enum { MISSING = 10, NEEDS_APPROVAL = 11, NO_KEYCHAIN = 12, FAILED = 13, LOCKED = 14 };

static bool valid_account(const char *account) {
    return strlen(account) == 36 && strspn(account, "0123456789abcdef-") == 36;
}

static int find_key(SecKeychainRef keychain, const char *account, unsigned char key[KEY_BYTES]) {
    UInt32 length = 0;
    void *data = NULL;
    OSStatus status = SecKeychainFindGenericPassword(
        keychain, sizeof(SERVICE) - 1, SERVICE, (UInt32)strlen(account), account, &length, &data, NULL);
    if (status == errSecItemNotFound) return MISSING;
    if (status == errSecInteractionNotAllowed || status == errSecAuthFailed) return NEEDS_APPROVAL;
    if (status != errSecSuccess || !data) return FAILED;
    if (length == KEY_BYTES) memcpy(key, data, KEY_BYTES);
    SecKeychainItemFreeContent(NULL, data);
    return length == KEY_BYTES ? 0 : FAILED;
}

static bool keychain_exists(SecKeychainRef keychain) {
    char path[4096];
    UInt32 size = sizeof(path) - 1;
    struct stat info;
    if (SecKeychainGetPath(keychain, &size, path) != errSecSuccess || size >= sizeof(path)) return false;
    path[size] = '\0';
    return stat(path, &info) == 0 && S_ISREG(info.st_mode);
}

int main(int argc, char **argv) {
    if (argc != 3 || !valid_account(argv[2])) return FAILED;
    bool create = strcmp(argv[1], "create") == 0;
    bool approve = strcmp(argv[1], "approve") == 0;
    if (!create && !approve && strcmp(argv[1], "read") != 0) return FAILED;

    if (SecKeychainSetUserInteractionAllowed(false) != errSecSuccess) return FAILED;
    SecKeychainRef keychain = NULL;
    if (SecKeychainCopyDefault(&keychain) != errSecSuccess || !keychain) return NO_KEYCHAIN;
    SecKeychainStatus flags = 0;
    if (!keychain_exists(keychain) || SecKeychainGetStatus(keychain, &flags) != errSecSuccess) {
        CFRelease(keychain);
        return NO_KEYCHAIN;
    }
    if (!(flags & kSecUnlockStateStatus)) {
        CFRelease(keychain);
        return LOCKED;
    }

    unsigned char key[KEY_BYTES] = {0};
    int result = find_key(keychain, argv[2], key);
    if (result == NEEDS_APPROVAL && approve) {
        if (SecKeychainSetUserInteractionAllowed(true) == errSecSuccess) {
            result = find_key(keychain, argv[2], key);
        }
    }
    if (result == MISSING && create) {
        arc4random_buf(key, sizeof(key));
        OSStatus status = SecKeychainAddGenericPassword(
            keychain, sizeof(SERVICE) - 1, SERVICE, (UInt32)strlen(argv[2]), argv[2], sizeof(key), key, NULL);
        if (status == errSecDuplicateItem) result = find_key(keychain, argv[2], key);
        else result = status == errSecSuccess ? 0 : FAILED;
    }
    CFRelease(keychain);
    if (result == 0 && (fwrite(key, 1, sizeof(key), stdout) != sizeof(key) || fflush(stdout) != 0)) result = FAILED;
    for (volatile unsigned char *byte = key; byte < key + sizeof(key); ++byte) *byte = 0;
    return result;
}
