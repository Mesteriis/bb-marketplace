# Third-party notices

## @xterm/xterm

Copyright (c) 2017-2024, The xterm.js authors (https://xtermjs.org/)

MIT License. Used for the embedded terminal in the Remote Hub SSH view.
Version 5.5.0. Source: https://github.com/xtermjs/xterm.js

## @xterm/addon-fit

Copyright (c) 2017-2024, The xterm.js authors (https://xtermjs.org/)

MIT License. Used to fit the terminal to its container.
Version 0.10.0. Source: https://github.com/xtermjs/xterm.js

## zod

Copyright (c) 2025 Colin McDonnell. MIT licence (the text below). Version 4.6.7, bundled in the plugin's server code.
Source: https://github.com/colinhacks/zod

## @tsparticles/engine

Copyright (c) 2020 Matteo Bruni. MIT licence (the text below). Version 4.6.0 (the engine only, no shape, updater or colour
bundles), loaded lazily the first time an agent holds a session, to draw the dots of the agent overlay.
Source: https://github.com/tsparticles/tsparticles

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## IronRDP (Devolutions)

Remote Hub's RDP engine uses the IronRDP client crates. Copyright (c)
Devolutions Inc. MIT OR Apache-2.0. Source: https://github.com/Devolutions/IronRDP

Pinned versions (see docs/rdp-engine.md): ironrdp-connector 0.12.0,
ironrdp-tokio 0.12.0, ironrdp-tls 0.3.0, ironrdp-session 0.13.0, ironrdp-pdu
0.11.0, ironrdp-graphics 0.11.0, ironrdp-input 0.9.0, ironrdp-core 0.3.1, plus
the transitive ironrdp-async 0.12.0, ironrdp-svc 0.10.0, ironrdp-error 0.2.1,
ironrdp-dvc 0.10.0, ironrdp-displaycontrol 0.10.0, ironrdp-bulk 0.2.0,
ironrdp-egfx 0.5.0, ironrdp-rdpei 0.3.0.

## tokio / tokio-rustls

Copyright (c) Tokio Contributors. MIT License. Used for the async runtime and
the rustls transport of the RDP engine. https://github.com/tokio-rs/tokio

## rustls

rustls is dual licensed under Apache-2.0, ISC and MIT. Used for the RDP TLS
transport. https://github.com/rustls/rustls

## ring

Copyright (c) 2015-2016 the fiat-crypto authors and the ring authors. Ring is
licensed under the ISC-style license plus the OpenSSL and SSLeay licenses (see
the ring LICENSE). Used as the rustls crypto provider.
https://github.com/briansmith/ring

## sspi

Copyright (c) 2021 Devolutions Inc. MIT OR Apache-2.0. CredSSP/NLA security
support provider used by ironrdp-connector. https://github.com/Devolutions/sspi-rs

## x509-cert

Apache-2.0 OR MIT. X.509 certificate parsing used to extract the server
certificate subject/issuer/validity for the certificate prompt.
https://github.com/RustCrypto/formats/tree/master/x509-cert

## sha2

Copyright (c) 2006-2009 Graydon Hoare, 2009-2013 Mozilla Foundation, 2016-2024
RustCrypto Developers. MIT OR Apache-2.0. SHA-256 certificate fingerprints.
https://github.com/RustCrypto/hashes

## png

Copyright (c) The image-rs Developers. MIT OR Apache-2.0. PNG encoder for the
RDP screenshot. https://github.com/image-rs/image-png

## picky, picky-asn1*, picky-krb

Copyright (c) Devolutions Inc. MIT OR Apache-2.0. ASN.1/X.509/Kerberos
building blocks pulled in by sspi (picky 7.0.0-rc.26, a release candidate, is
the version sspi 0.23.0 requires). https://github.com/Devolutions/picky-rs

## rustls-native-certs, security-framework

rustls-native-certs: Apache-2.0 OR ISC OR MIT. security-framework: MIT OR
Apache-2.0. Load the macOS system roots for strict TLS validation of the RDP
server certificate. https://github.com/rustls/rustls-native-certs

security-framework (3.7.0, the version already in the dependency tree) is also a direct
dependency since stage 3b: the helper stores and reads generic passwords in the
macOS Keychain with it. https://github.com/kornelski/rust-security-framework

## rustls-webpki, untrusted

ISC. Certificate path validation and the byte parser it uses.
https://github.com/rustls/webpki

## RustCrypto and related cryptography crates

aes, aes-gcm, aes-kw, cbc, ctr, des, rc2, rsa, hkdf, hmac, pbkdf2, sha1, sha2,
sha3, md-5, md4, p256, p384, p521, ecdsa, ed25519, elliptic-curve, der, spki,
pkcs1, pkcs8, sec1, signature, crypto-bigint and the supporting crates: MIT OR
Apache-2.0 (some Apache-2.0 OR MIT). curve25519-dalek, ed25519-dalek,
x25519-dalek and subtle: BSD-3-Clause. Pulled in by sspi / picky for
NTLM/CredSSP and by x509-cert. https://github.com/RustCrypto

## Other linked crates

Every crate in the helper's release dependency tree (`cargo tree --locked
--target aarch64-apple-darwin -e normal`) is permissively licensed:

- MIT OR Apache-2.0 (and Apache-2.0 OR MIT): the majority, including serde,
  serde_json, libc, futures, png, flate2, thiserror,
  time, url, asn1-rs, der-parser, ironrdp-*.
- MIT: tokio, mio, bytes, tracing, nom, bitvec, generic-array, async-dnssd.
- Unicode-3.0: the icu_*, zerovec, yoke, tinystr, litemap and related crates
  (via idna/url).
- ISC: ring (with its OpenSSL/SSLeay-derived parts: Apache-2.0 AND ISC),
  libloading, iso7816-tlv.
- BSD-3-Clause, BSD-2-Clause OR Apache-2.0 OR MIT (zerocopy), Zlib OR
  Apache-2.0 OR MIT (bytemuck, wide, miniz_oxide), Unlicense OR MIT (memchr,
  byteorder), 0BSD OR MIT OR Apache-2.0 (adler2), Apache-2.0 (cryptoki,
  flagset).

aws-lc-rs is in the lockfile but not linked into any target Remote Hub builds;
the only rustls crypto provider is ring.

The RDP engine now depends directly on tracing-core 0.1.36 (MIT; already in the tree through ironrdp) to count the
warnings IronRDP logs when it discards an update; `tracing` 0.1.44 (MIT) is a dev-dependency used by its unit test.

## Proxmox VE engine dependencies

The `--pve-engine` process (helper/src/pve/) adds these direct dependencies, all permissively licensed and pinned
to exact versions in `helper/Cargo.toml`: tokio-tungstenite 0.30.0 (MIT) and tungstenite 0.30.0 (MIT OR Apache-2.0)
for the console websocket, with their handshake helpers data-encoding 2.11.1 (MIT), httparse 1.10.1 (MIT OR Apache-2.0)
and the sha1 crate already in the tree; hyper 1.9.0 (MIT) with hyper-util 0.1.20 (MIT), http-body 1.1.0 and
http-body-util 0.1.3 (MIT), httpdate 1.0.3 (MIT OR Apache-2.0), want 0.3.2 and try-lock 0.2.5 (MIT) and atomic-waker 1.1.2
(Apache-2.0 OR MIT) for the HTTP/1.1 client; rustls, tokio-rustls and rustls-native-certs (as above) now ship, with the
`ring` provider only. No system-wide TLS switch exists: the engine trusts the system roots, one supplied CA, or one
pinned certificate.

Test-only (never in the shipped binary): hyper's `server` feature for the fake PVE server, and a throwaway test CA
and leaf certificate under `helper/tests/fixtures/tls-*.der` generated with openssl.

<!-- BEGIN GENERATED CRATES -->

## Every linked crate

Generated by `scripts/gen-notices.mjs` from Cargo.lock: the 268 crates linked into the release helper (normal dependencies, aarch64-apple-darwin). Licence texts are in each crate's source distribution (crates.io).

| Crate | Version | Licence |
| --- | --- | --- |
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 |
| aead | 0.6.1 | MIT OR Apache-2.0 |
| aes | 0.9.4 | MIT OR Apache-2.0 |
| aes-gcm | 0.11.1 | Apache-2.0 OR MIT |
| aes-kw | 0.3.1 | MIT OR Apache-2.0 |
| asn1-rs | 0.7.2 | MIT OR Apache-2.0 |
| asn1-rs-derive | 0.6.0 | MIT OR Apache-2.0 |
| asn1-rs-impl | 0.2.0 | MIT/Apache-2.0 |
| async-dnssd | 0.5.1 | MIT |
| async-recursion | 1.2.0 | MIT OR Apache-2.0 |
| atomic-waker | 1.1.2 | Apache-2.0 OR MIT |
| aws-lc-rs | 1.19.0 | ISC AND (Apache-2.0 OR ISC) |
| aws-lc-sys | 0.47.0 | ISC AND (Apache-2.0 OR ISC) AND Apache-2.0 AND MIT AND BSD-3-Clause AND (Apache-2.0 OR ISC OR MIT) AND (Apache-2.0 OR ISC OR MIT-0) |
| base16ct | 1.0.0 | Apache-2.0 OR MIT |
| base64 | 0.22.1 | MIT OR Apache-2.0 |
| base64 | 0.23.1 | MIT OR Apache-2.0 |
| base64ct | 1.8.3 | Apache-2.0 OR MIT |
| bit_field | 0.10.4 | MIT OR Apache-2.0 |
| bitflags | 1.3.2 | MIT/Apache-2.0 |
| bitflags | 2.13.2 | MIT OR Apache-2.0 |
| bitvec | 1.1.1 | MIT |
| block-buffer | 0.10.4 | MIT OR Apache-2.0 |
| block-buffer | 0.12.1 | MIT OR Apache-2.0 |
| block-padding | 0.4.2 | MIT OR Apache-2.0 |
| bytemuck | 1.25.2 | Zlib OR Apache-2.0 OR MIT |
| byteorder | 1.5.0 | Unlicense OR MIT |
| bytes | 1.12.1 | MIT |
| cbc | 0.2.1 | MIT OR Apache-2.0 |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 |
| chacha20 | 0.10.2 | MIT OR Apache-2.0 |
| cipher | 0.5.2 | MIT OR Apache-2.0 |
| cmov | 0.5.4 | Apache-2.0 OR MIT |
| const-oid | 0.10.3 | Apache-2.0 OR MIT |
| const-oid | 0.9.6 | Apache-2.0 OR MIT |
| core-foundation | 0.10.1 | MIT OR Apache-2.0 |
| core-foundation-sys | 0.8.7 | MIT OR Apache-2.0 |
| cpubits | 0.1.1 | MIT OR Apache-2.0 |
| cpufeatures | 0.3.1 | MIT OR Apache-2.0 |
| crc32fast | 1.5.5 | MIT OR Apache-2.0 |
| crypto-bigint | 0.7.11 | Apache-2.0 OR MIT |
| crypto-common | 0.1.7 | MIT OR Apache-2.0 |
| crypto-common | 0.2.2 | MIT OR Apache-2.0 |
| crypto-mac | 0.11.0 | MIT OR Apache-2.0 |
| crypto-primes | 0.7.2 | Apache-2.0 OR MIT |
| cryptoki | 0.12.1 | Apache-2.0 |
| cryptoki-sys | 0.5.0 | Apache-2.0 |
| ctr | 0.10.1 | MIT OR Apache-2.0 |
| ctutils | 0.4.8 | Apache-2.0 OR MIT |
| curve25519-dalek | 5.0.0 | BSD-3-Clause |
| data-encoding | 2.11.1 | MIT |
| der | 0.7.10 | Apache-2.0 OR MIT |
| der | 0.8.3 | Apache-2.0 OR MIT |
| der_derive | 0.8.0 | Apache-2.0 OR MIT |
| der-parser | 10.0.0 | MIT OR Apache-2.0 |
| deranged | 0.5.9 | MIT OR Apache-2.0 |
| des | 0.9.0 | MIT OR Apache-2.0 |
| digest | 0.10.7 | MIT OR Apache-2.0 |
| digest | 0.11.3 | MIT OR Apache-2.0 |
| displaydoc | 0.2.7 | MIT OR Apache-2.0 |
| ecdsa | 0.17.0 | Apache-2.0 OR MIT |
| ed25519 | 3.0.0 | Apache-2.0 OR MIT |
| ed25519-dalek | 3.0.0 | BSD-3-Clause |
| elliptic-curve | 0.14.3 | Apache-2.0 OR MIT |
| fdeflate | 0.3.7 | MIT OR Apache-2.0 |
| ff | 0.14.0 | MIT/Apache-2.0 |
| flagset | 0.4.7 | Apache-2.0 |
| flate2 | 1.1.11 | MIT OR Apache-2.0 |
| form_urlencoded | 1.2.2 | MIT OR Apache-2.0 |
| funty | 2.0.0 | MIT |
| futures | 0.3.34 | MIT OR Apache-2.0 |
| futures-channel | 0.3.34 | MIT OR Apache-2.0 |
| futures-core | 0.3.34 | MIT OR Apache-2.0 |
| futures-executor | 0.3.34 | MIT OR Apache-2.0 |
| futures-io | 0.3.34 | MIT OR Apache-2.0 |
| futures-macro | 0.3.34 | MIT OR Apache-2.0 |
| futures-sink | 0.3.34 | MIT OR Apache-2.0 |
| futures-task | 0.3.34 | MIT OR Apache-2.0 |
| futures-util | 0.3.34 | MIT OR Apache-2.0 |
| generic-array | 0.14.7 | MIT |
| getrandom | 0.2.17 | MIT OR Apache-2.0 |
| getrandom | 0.3.4 | MIT OR Apache-2.0 |
| getrandom | 0.4.3 | MIT OR Apache-2.0 |
| ghash | 0.6.0 | Apache-2.0 OR MIT |
| group | 0.14.0 | MIT/Apache-2.0 |
| hash32 | 0.2.1 | MIT OR Apache-2.0 |
| heapless | 0.7.17 | MIT OR Apache-2.0 |
| hex | 0.4.3 | MIT OR Apache-2.0 |
| hkdf | 0.13.0 | MIT OR Apache-2.0 |
| hmac | 0.12.1 | MIT OR Apache-2.0 |
| hmac | 0.13.0 | MIT OR Apache-2.0 |
| http | 1.5.0 | MIT OR Apache-2.0 |
| http-body | 1.1.0 | MIT |
| http-body-util | 0.1.3 | MIT |
| httparse | 1.10.1 | MIT OR Apache-2.0 |
| httpdate | 1.0.3 | MIT OR Apache-2.0 |
| hybrid-array | 0.4.15 | MIT OR Apache-2.0 |
| hyper | 1.9.0 | MIT |
| hyper-util | 0.1.20 | MIT |
| icu_collections | 2.4.0 | Unicode-3.0 |
| icu_locale_core | 2.4.0 | Unicode-3.0 |
| icu_normalizer | 2.4.0 | Unicode-3.0 |
| icu_normalizer_data | 2.4.0 | Unicode-3.0 |
| icu_properties | 2.4.0 | Unicode-3.0 |
| icu_properties_data | 2.4.0 | Unicode-3.0 |
| icu_provider | 2.4.0 | Unicode-3.0 |
| idna | 1.1.0 | MIT OR Apache-2.0 |
| idna_adapter | 1.2.2 | Apache-2.0 OR MIT |
| inout | 0.2.6 | MIT OR Apache-2.0 |
| ironrdp-async | 0.12.0 | MIT OR Apache-2.0 |
| ironrdp-bulk | 0.2.0 | MIT OR Apache-2.0 |
| ironrdp-connector | 0.12.0 | MIT OR Apache-2.0 |
| ironrdp-core | 0.3.1 | MIT OR Apache-2.0 |
| ironrdp-displaycontrol | 0.10.0 | MIT OR Apache-2.0 |
| ironrdp-dvc | 0.10.0 | MIT OR Apache-2.0 |
| ironrdp-egfx | 0.5.0 | MIT OR Apache-2.0 |
| ironrdp-error | 0.2.1 | MIT OR Apache-2.0 |
| ironrdp-graphics | 0.11.0 | MIT OR Apache-2.0 |
| ironrdp-input | 0.9.0 | MIT OR Apache-2.0 |
| ironrdp-pdu | 0.11.0 | MIT OR Apache-2.0 |
| ironrdp-rdpei | 0.3.0 | MIT OR Apache-2.0 |
| ironrdp-session | 0.13.0 | MIT OR Apache-2.0 |
| ironrdp-svc | 0.10.0 | MIT OR Apache-2.0 |
| ironrdp-tls | 0.3.0 | MIT OR Apache-2.0 |
| ironrdp-tokio | 0.12.0 | MIT OR Apache-2.0 |
| iso7816 | 0.1.4 | Apache-2.0 OR MIT |
| iso7816-tlv | 0.4.4 | ISC |
| itoa | 1.0.19 | MIT OR Apache-2.0 |
| keccak | 0.2.2 | Apache-2.0 OR MIT |
| libc | 0.2.191 | MIT OR Apache-2.0 |
| libloading | 0.8.9 | ISC |
| libz-sys | 1.1.33 | MIT OR Apache-2.0 |
| litemap | 0.8.3 | Unicode-3.0 |
| log | 0.4.35 | MIT OR Apache-2.0 |
| md-5 | 0.10.6 | MIT OR Apache-2.0 |
| md-5 | 0.11.0 | MIT OR Apache-2.0 |
| md4 | 0.11.0 | MIT OR Apache-2.0 |
| memchr | 2.8.3 | Unlicense OR MIT |
| minimal-lexical | 0.2.1 | MIT/Apache-2.0 |
| miniz_oxide | 0.8.9 | MIT OR Zlib OR Apache-2.0 |
| miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 |
| mio | 1.2.5 | MIT |
| nom | 7.1.3 | MIT |
| num-bigint | 0.4.8 | MIT OR Apache-2.0 |
| num-conv | 0.2.2 | MIT OR Apache-2.0 |
| num-derive | 0.5.1 | MIT OR Apache-2.0 |
| num-integer | 0.1.47 | MIT OR Apache-2.0 |
| num-traits | 0.2.19 | MIT OR Apache-2.0 |
| oid | 0.2.1 | MIT OR Apache-2.0 |
| once_cell | 1.21.4 | MIT OR Apache-2.0 |
| p256 | 0.14.0 | Apache-2.0 OR MIT |
| p384 | 0.14.0 | Apache-2.0 OR MIT |
| p521 | 0.14.0 | Apache-2.0 OR MIT |
| pbkdf2 | 0.13.0 | MIT OR Apache-2.0 |
| pem-rfc7468 | 1.0.0 | Apache-2.0 OR MIT |
| percent-encoding | 2.3.2 | MIT OR Apache-2.0 |
| picky | 7.0.0-rc.26 | MIT OR Apache-2.0 |
| picky-asn1 | 0.10.2 | MIT OR Apache-2.0 |
| picky-asn1-der | 0.5.7 | MIT OR Apache-2.0 |
| picky-asn1-x509 | 0.15.6 | MIT OR Apache-2.0 |
| picky-krb | 0.12.4 | MIT OR Apache-2.0 |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT |
| pin-utils | 0.1.1 | MIT OR Apache-2.0 |
| pkcs1 | 0.7.5 | Apache-2.0 OR MIT |
| pkcs1 | 0.8.0-rc.4 | Apache-2.0 OR MIT |
| pkcs8 | 0.10.2 | Apache-2.0 OR MIT |
| pkcs8 | 0.11.0 | Apache-2.0 OR MIT |
| png | 0.18.1 | MIT OR Apache-2.0 |
| polyval | 0.7.3 | Apache-2.0 OR MIT |
| potential_utf | 0.1.6 | Unicode-3.0 |
| powerfmt | 0.2.1 | MIT OR Apache-2.0 |
| ppv-lite86 | 0.2.21 | MIT OR Apache-2.0 |
| primefield | 0.14.0 | Apache-2.0 OR MIT |
| primeorder | 0.14.0 | Apache-2.0 OR MIT |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 |
| quote | 1.0.47 | MIT OR Apache-2.0 |
| radium | 0.7.0 | MIT |
| rand | 0.10.4 | MIT OR Apache-2.0 |
| rand | 0.9.5 | MIT OR Apache-2.0 |
| rand_chacha | 0.9.0 | MIT OR Apache-2.0 |
| rand_core | 0.10.1 | MIT OR Apache-2.0 |
| rand_core | 0.9.5 | MIT OR Apache-2.0 |
| rc2 | 0.9.0 | MIT OR Apache-2.0 |
| rfc6979 | 0.6.0 | Apache-2.0 OR MIT |
| ring | 0.17.14 | Apache-2.0 AND ISC |
| rsa | 0.10.0-rc.18 | MIT OR Apache-2.0 |
| rusticata-macros | 4.1.0 | MIT/Apache-2.0 |
| rustls | 0.23.46 | Apache-2.0 OR ISC OR MIT |
| rustls-native-certs | 0.8.5 | Apache-2.0 OR ISC OR MIT |
| rustls-pki-types | 1.16.0 | MIT OR Apache-2.0 |
| rustls-webpki | 0.103.17 | ISC |
| safe_arch | 0.7.4 | Zlib OR Apache-2.0 OR MIT |
| sec1 | 0.8.1 | Apache-2.0 OR MIT |
| secrecy | 0.10.3 | Apache-2.0 OR MIT |
| security-framework | 3.7.0 | MIT OR Apache-2.0 |
| security-framework-sys | 2.17.0 | MIT OR Apache-2.0 |
| serde | 1.0.229 | MIT OR Apache-2.0 |
| serde_bytes | 0.11.19 | MIT OR Apache-2.0 |
| serde_core | 1.0.229 | MIT OR Apache-2.0 |
| serde_derive | 1.0.229 | MIT OR Apache-2.0 |
| serde_json | 1.0.154 | MIT OR Apache-2.0 |
| serdect | 0.4.3 | Apache-2.0 OR MIT |
| sha1 | 0.11.0 | MIT OR Apache-2.0 |
| sha2 | 0.11.1 | MIT OR Apache-2.0 |
| sha3 | 0.12.0 | MIT OR Apache-2.0 |
| signature | 3.0.0 | Apache-2.0 OR MIT |
| simd-adler32 | 0.3.10 | MIT |
| slab | 0.4.12 | MIT |
| smallvec | 1.16.5 | MIT OR Apache-2.0 |
| socket2 | 0.6.5 | MIT OR Apache-2.0 |
| spki | 0.7.3 | Apache-2.0 OR MIT |
| spki | 0.8.1 | Apache-2.0 OR MIT |
| sponge-cursor | 0.1.0 | MIT OR Apache-2.0 |
| sspi | 0.23.0 | MIT OR Apache-2.0 |
| stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 |
| subtle | 2.6.1 | BSD-3-Clause |
| syn | 2.0.119 | MIT OR Apache-2.0 |
| syn | 3.0.10 | MIT OR Apache-2.0 |
| synstructure | 0.13.2 | MIT |
| synstructure | 0.14.0 | MIT |
| tap | 1.0.1 | MIT |
| thiserror | 2.0.21 | MIT OR Apache-2.0 |
| thiserror-impl | 2.0.21 | MIT OR Apache-2.0 |
| time | 0.3.55 | MIT OR Apache-2.0 |
| time-core | 0.1.9 | MIT OR Apache-2.0 |
| time-macros | 0.2.32 | MIT OR Apache-2.0 |
| tinystr | 0.8.5 | Unicode-3.0 |
| tls_codec | 0.4.2 | Apache-2.0 OR MIT |
| tls_codec_derive | 0.4.2 | Apache-2.0 OR MIT |
| tokio | 1.54.1 | MIT |
| tokio-macros | 2.7.2 | MIT |
| tokio-rustls | 0.26.6 | MIT OR Apache-2.0 |
| tokio-tungstenite | 0.30.0 | MIT |
| tracing | 0.1.44 | MIT |
| tracing-attributes | 0.1.31 | MIT |
| tracing-core | 0.1.36 | MIT |
| try-lock | 0.2.5 | MIT |
| tungstenite | 0.30.0 | MIT OR Apache-2.0 |
| typenum | 1.20.1 | MIT OR Apache-2.0 |
| unicode-ident | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 |
| universal-hash | 0.6.1 | MIT OR Apache-2.0 |
| untrusted | 0.9.0 | ISC |
| url | 2.5.8 | MIT OR Apache-2.0 |
| utf_types | 1.0.0 | Apache-2.0 OR MIT |
| utf8_iter | 1.1.0 | Apache-2.0 OR MIT |
| uuid | 1.29.3 | Apache-2.0 OR MIT |
| want | 0.3.2 | MIT |
| web-time | 1.1.0 | MIT OR Apache-2.0 |
| wide | 0.7.33 | Zlib OR Apache-2.0 OR MIT |
| widestring | 1.2.1 | MIT OR Apache-2.0 |
| winscard | 0.4.0 | MIT/Apache-2.0 |
| wnaf | 0.14.1 | Apache-2.0 OR MIT |
| writeable | 0.6.4 | Unicode-3.0 |
| wyz | 0.5.1 | MIT |
| x25519-dalek | 3.0.0 | BSD-3-Clause |
| x509-cert | 0.3.0 | Apache-2.0 OR MIT |
| yoke | 0.8.4 | Unicode-3.0 |
| yoke-derive | 0.8.4 | Unicode-3.0 |
| yuv | 0.8.20 | BSD-3-Clause OR Apache-2.0 |
| zerocopy | 0.8.63 | BSD-2-Clause OR Apache-2.0 OR MIT |
| zerofrom | 0.1.8 | Unicode-3.0 |
| zerofrom-derive | 0.1.8 | Unicode-3.0 |
| zeroize | 1.9.1 | Apache-2.0 OR MIT |
| zeroize_derive | 1.5.0 | Apache-2.0 OR MIT |
| zerotrie | 0.2.5 | Unicode-3.0 |
| zerovec | 0.11.9 | Unicode-3.0 |
| zerovec-derive | 0.11.7 | Unicode-3.0 |
| zlib-rs | 0.6.8 | Zlib |
| zmij | 1.0.23 | MIT |

<!-- END GENERATED CRATES -->
