type ZipEntry = {
  name: string;
  localName?: string;
  contents?: Buffer;
  mode?: number;
  dataDescriptor?: boolean;
  localFlags?: number;
  localExtra?: Buffer;
  method?: number;
  localMethod?: number;
  localCompressedSize?: number;
};

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function storedZip(entries: ZipEntry[], hiddenLocalEntries: ZipEntry[] = []): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let localOffset = 0;
  const appendEntry = (entry: ZipEntry, listed: boolean) => {
    const name = Buffer.from(entry.name);
    const localName = Buffer.from(entry.localName ?? entry.name);
    const localExtra = entry.localExtra ?? Buffer.alloc(0);
    const contents = entry.contents ?? Buffer.alloc(0);
    const crc = crc32(contents);
    const dosDate = 0x0021;
    const flags = entry.dataDescriptor ? 0x0008 : 0;
    const method = entry.method ?? 0;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(entry.localFlags ?? flags, 6);
    localHeader.writeUInt16LE(entry.localMethod ?? method, 8);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(entry.dataDescriptor ? 0 : crc, 14);
    localHeader.writeUInt32LE(
      entry.dataDescriptor ? 0 : (entry.localCompressedSize ?? contents.length),
      18,
    );
    localHeader.writeUInt32LE(entry.dataDescriptor ? 0 : contents.length, 22);
    localHeader.writeUInt16LE(localName.length, 26);
    localHeader.writeUInt16LE(localExtra.length, 28);
    local.push(localHeader, localName, localExtra, contents);
    if (entry.dataDescriptor) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(contents.length, 8);
      descriptor.writeUInt32LE(contents.length, 12);
      local.push(descriptor);
    }

    if (listed) {
      const centralHeader = Buffer.alloc(46);
      centralHeader.writeUInt32LE(0x02014b50, 0);
      centralHeader.writeUInt16LE((3 << 8) | 20, 4);
      centralHeader.writeUInt16LE(20, 6);
      centralHeader.writeUInt16LE(flags, 8);
      centralHeader.writeUInt16LE(method, 10);
      centralHeader.writeUInt16LE(dosDate, 14);
      centralHeader.writeUInt32LE(crc, 16);
      centralHeader.writeUInt32LE(contents.length, 20);
      centralHeader.writeUInt32LE(contents.length, 24);
      centralHeader.writeUInt16LE(name.length, 28);
      centralHeader.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
      centralHeader.writeUInt32LE(localOffset, 42);
      central.push(centralHeader, name);
    }
    localOffset +=
      localHeader.length +
      localName.length +
      localExtra.length +
      contents.length +
      (entry.dataDescriptor ? 16 : 0);
  };
  for (const entry of entries) appendEntry(entry, true);
  for (const entry of hiddenLocalEntries) appendEntry(entry, false);

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...local, directory, end]);
}
