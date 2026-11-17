# Third-party notices

## @xterm/xterm

Copyright (c) 2017-2024, The xterm.js authors (https://xtermjs.org/)

MIT License. Used for the embedded terminal in the Remote Hub SSH view.
Version 5.5.0. Source: https://github.com/xtermjs/xterm.js

## @xterm/addon-fit

Copyright (c) 2017-2024, The xterm.js authors (https://xtermjs.org/)

MIT License. Used to fit the terminal to its container.
Version 0.10.0. Source: https://github.com/xtermjs/xterm.js

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

Test-only (never in the shipped binary): rustls and tokio-rustls as
dev-dependencies, and a throwaway test CA and leaf certificate under
`helper/tests/fixtures/tls-*.der` generated with openssl.
