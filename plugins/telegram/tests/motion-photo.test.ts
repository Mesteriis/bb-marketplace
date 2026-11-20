// @vitest-environment jsdom
import { File as NodeFile } from "node:buffer";
import { afterEach, expect, test, vi } from "vitest";
import { importMotionPhoto } from "../src/ui/import-motion-photo.ts";

const clip = Buffer.from("00000010667479706d703432000000006d703432", "hex");
const padding = Buffer.alloc(3);
const gainMap = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const xmpHeader = Buffer.from("http://ns.adobe.com/xap/1.0/\0");

afterEach(() => vi.unstubAllGlobals());

function xml(properties: string, children = "") {
  return `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
    xmlns:C="http://ns.google.com/photos/1.0/camera/"
    xmlns:D="http://ns.google.com/photos/1.0/container/"
    xmlns:I="http://ns.google.com/photos/1.0/container/item/">
    <rdf:Description ${properties}>${children}</rdf:Description>
  </rdf:RDF>`;
}

function jpeg(xmp: string) {
  const packet = Buffer.concat([xmpHeader, Buffer.from(xmp)]);
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(packet.length + 2, 4);
  return Buffer.concat([header, packet, Buffer.from([0xff, 0xd9])]);
}

function wideJpeg(still: Buffer) {
  // Place APP1 across the parser's read-window boundary.
  const segment = Buffer.alloc(65530);
  segment.set([0xff, 0xe2]);
  segment.writeUInt16BE(segment.length - 2, 2);
  return Buffer.concat([still.subarray(0, 2), segment, still.subarray(2)]);
}

function directory(length: number) {
  return `<D:Directory><rdf:Seq>
    <rdf:li rdf:parseType="Resource"><D:Item I:Mime="image/jpeg" I:Semantic="Primary" I:Padding="3"/></rdf:li>
    <rdf:li I:Mime="image/jpeg" I:Semantic="GainMap" I:Length="4"/>
    <rdf:li rdf:parseType="Resource"><D:Item I:Mime="video/quicktime" I:Semantic="MotionPhoto" I:Length="${length}"/></rdf:li>
  </rdf:Seq></D:Directory>`;
}

test("splits an Android Motion Photo JPEG using its namespaced XMP, padding and gain map", async () => {
  vi.stubGlobal("File", NodeFile);
  const still = wideJpeg(jpeg(xml('C:MotionPhoto="1"', directory(clip.length))));
  const source = new File([still, padding, gainMap, clip], "FixtureMP.jpg", { type: "image/jpeg" });
  const pair = await importMotionPhoto(source);
  expect(pair?.still.name).toBe("FixtureMP.jpg");
  expect(pair?.clip.name).toBe("FixtureMP.mov");
  expect(pair?.clip.type).toBe("video/quicktime");
  expect(Buffer.from(await pair!.still.arrayBuffer())).toEqual(still);
  expect(Buffer.from(await pair!.clip.arrayBuffer())).toEqual(clip);
});

test("reads legacy MicroVideo offsets only when modern Motion Photo metadata is absent", async () => {
  vi.stubGlobal("File", NodeFile);
  const still = jpeg(xml(`C:MicroVideo="1" C:MicroVideoOffset="${clip.length}"`));
  const pair = await importMotionPhoto(new File([still, clip], "Fixture.jpg"));
  expect(pair?.clip.name).toBe("Fixture.mp4");
  expect(Buffer.from(await pair!.clip.arrayBuffer())).toEqual(clip);
});

test("rejects static, truncated, disabled, and invalid Motion Photo JPEGs", async () => {
  vi.stubGlobal("File", NodeFile);
  const metadata = (value: number, length: number) => jpeg(xml(`C:MotionPhoto="${value}"`, directory(length)));
  const candidates = [
    new File([jpeg(xml(""))], "static.jpg"),
    new File([metadata(0, clip.length), padding, gainMap, clip], "disabled.jpg"),
    new File([metadata(1, clip.length), padding, gainMap, clip.subarray(0, 16)], "truncated.jpg"),
    new File([metadata(1, clip.length), padding, gainMap, Buffer.alloc(clip.length)], "wrong-container.jpg"),
    new File([metadata(1, 2147483647), padding, gainMap, clip], "invalid-offset.jpg"),
  ];
  for (const file of candidates) await expect(importMotionPhoto(file)).resolves.toBeUndefined();
});

function box(type: string, ...payload: Buffer[]) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.reduce((length, bytes) => length + bytes.length, 0));
  header.write(type, 4, "ascii");
  return Buffer.concat([header, ...payload]);
}

function avif(enabled: number, indexed: boolean, padding = 8, brand = "avif") {
  const xmp = Buffer.from(xml(`C:MotionPhoto="${enabled}"`, `<D:Directory><rdf:Seq>
    <rdf:li I:Mime="image/${brand}" I:Semantic="Primary" I:Padding="${padding}"/>
    <rdf:li I:Mime="video/mp4" I:Semantic="MotionPhoto" I:Length="${clip.length}"/>
  </rdf:Seq></D:Directory>`));
  const ftyp = box("ftyp", Buffer.from(`${brand}\0\0\0\0${brand}`, "ascii"));
  const info = box("iinf", Buffer.from([0, 0, 0, 0, 0, 1]), box("infe",
    Buffer.from([2, 0, 0, 0, 0, 1, 0, 0]), Buffer.from("mimeXMP\0application/rdf+xml\0\0", "ascii")));
  const payload = Buffer.alloc(indexed ? 24 : 22);
  payload[0] = indexed ? 1 : 0;
  payload[4] = 0x44;
  payload.writeUInt16BE(1, 6);
  payload.writeUInt16BE(1, 8);
  if (indexed) payload.writeUInt16BE(1, 10);
  payload.writeUInt16BE(1, indexed ? 12 + 2 : 12);
  payload.writeUInt32BE(xmp.length, payload.length - 4);
  const data = box(indexed ? "idat" : "mdat", xmp);
  if (!indexed) payload.writeUInt32BE(ftyp.length + 12 + info.length + 8 + payload.length + 8, payload.length - 8);
  return indexed
    ? Buffer.concat([ftyp, box("meta", Buffer.alloc(4), info, box("iloc", payload), data)])
    : Buffer.concat([ftyp, box("meta", Buffer.alloc(4), info, box("iloc", payload)), data]);
}

test.each([false, true])("extracts AVIF still and clip using XMP item extents (idat=%s)", async (indexed) => {
  vi.stubGlobal("File", NodeFile);
  const still = avif(1, indexed);
  const pair = await importMotionPhoto(new File([still, box("mpvd", clip)], "FixtureMP.avif"));
  expect(pair?.still.type).toBe("image/avif");
  expect(pair?.clip.name).toBe("FixtureMP.mp4");
  expect(Buffer.from(await pair!.still.arrayBuffer())).toEqual(still);
  expect(Buffer.from(await pair!.clip.arrayBuffer())).toEqual(clip);
});

test("rejects AVIFs without a matching terminal motion box and XMP layout", async () => {
  vi.stubGlobal("File", NodeFile);
  const motion = box("mpvd", clip);
  for (const bytes of [
    avif(1, false),
    Buffer.concat([avif(0, false), motion]),
    Buffer.concat([avif(1, false, 7), motion]),
    Buffer.concat([avif(1, true), motion, box("free")]),
    Buffer.concat([avif(1, true), motion.subarray(0, -1)]),
  ]) await expect(importMotionPhoto(new File([bytes], "Fixture.avif"))).resolves.toBeUndefined();
});

test("extracts a HEIC Motion Photo even when the browser cannot decode its image", async () => {
  vi.stubGlobal("File", NodeFile);
  const still = avif(1, true, 8, "heic");
  const pair = await importMotionPhoto(new File([still, box("mpvd", clip)], "FixtureMP.heic"));
  expect(pair?.still.name).toBe("FixtureMP.heic");
  expect(pair?.still.type).toBe("image/heic");
  expect(Buffer.from(await pair!.still.arrayBuffer())).toEqual(still);
  expect(Buffer.from(await pair!.clip.arrayBuffer())).toEqual(clip);
});
