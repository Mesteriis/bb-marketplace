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

## aws-lc-rs

Copyright Amazon.com, Inc. or its affiliates. Apache-2.0. Used by the sspi
crate as its rustls crypto provider. https://github.com/aws/aws-lc-rs

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
