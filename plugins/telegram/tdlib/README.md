# TDLib extensions for communities

The patches target [TDLib commit 03220f6](https://github.com/tdlib/td/tree/03220f6b3043c6fd7785fbf0901d63f19ad19974). The first patch registers the read-only `makoshGetCommunityBannedMembers` JSON request. The logged-in TDLib client calls Telegram's `channels.getParticipants` with `channelParticipantsKicked` for the community channel. The request requires administrator access. The returned offset advances by the number of server rows received, including rows excluded from the displayed page.

The second patch registers `makoshGetChatFolderCommunities`. It reads explicit community membership and mixed chat/community pin order from the folder in TDLib. Ordinary folder edits preserve stored community peers.

The third patch registers `makoshSetChatFolderCommunity`. It compares the expected membership and changes a copy of the existing folder. A successful change enters TDLib’s standard server synchronization queue.

Apply the patches in order from a clean checkout of that commit and build with CMake and Ninja on Apple Silicon. Install the standard [TDLib build prerequisites](https://github.com/tdlib/td/tree/03220f6b3043c6fd7785fbf0901d63f19ad19974#building) first.

```sh
git apply /absolute/path/to/0001-community-banned-members.patch
git apply /absolute/path/to/0002-folder-communities.patch
git apply /absolute/path/to/0003-edit-folder-communities.patch
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 -DOPENSSL_ROOT_DIR="$(brew --prefix openssl@3)"
cmake --build build --target tdjson
```

Set `MAKOSH_TDJSON_PATH` in an isolated BB server profile to the absolute path of `build/libtdjson.dylib`. Follow the existing session backup procedure before using any newer TDLib build with a signed-in profile. The standard TDLib client remains supported. BB shows the community ban count and reports that the list is unavailable if TDLib does not recognize the extension.

TDLib is distributed under the [Boost Software License, Version 1.0](../licenses/TDLib-Boost-1.0.txt).
