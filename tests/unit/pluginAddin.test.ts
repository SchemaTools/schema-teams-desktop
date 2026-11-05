import { describe, it, expect } from 'vitest';
import { win32 } from 'node:path';
import {
  parseOwnAddin,
  renderAddin,
  resolveAssembly,
  softAddinEntries,
} from '../../src/main/plugins/addin';
import { fixtureGuid, fixtureXml } from '../helpers/pluginArchiveFixture';

const second = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
describe('own .addin from the build archive: narrow parser', () => {
  it('reads Application and Command entries with their fields in order', () => {
    const entries = parseOwnAddin(
      Buffer.from(
        `\ufeff<?xml version="1.0" encoding="utf-8"?>\r\n<!-- комментарий -->\r\n<RevitAddIns>
  <AddIn Type="Application"><Name>План &amp; схема</Name><Assembly>Plugin\\Plugin.dll</Assembly><AddInId>${fixtureGuid.toUpperCase()}</AddInId><FullClassName>Fixture.App</FullClassName><VendorId>TEST</VendorId></AddIn>
  <AddIn Type="Command"><Assembly>Plugin/Plugin.dll</Assembly><AddInId>${second}</AddInId><FullClassName>Fixture.Command</FullClassName><Text>Команда</Text></AddIn>
</RevitAddIns>`,
        'utf8',
      ),
    );
    expect(entries.map((e) => [e.type, e.addInId, e.assembly])).toEqual([
      ['Application', fixtureGuid, 'Plugin\\Plugin.dll'],
      ['Command', second, 'Plugin/Plugin.dll'],
    ]);
    expect(entries[0]?.fields[0]).toEqual(['Name', 'План & схема']);
  });
  it('accepts UTF-16 with BOM as written by Visual Studio', () => {
    const text = fixtureXml('Plugin.dll').toString('utf8');
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    expect(parseOwnAddin(bytes)[0]?.addInId).toBe(fixtureGuid);
  });
  it.each([
    [
      'XXE',
      '<!DOCTYPE RevitAddIns [<!ENTITY xxe SYSTEM "file:///C:/Windows/win.ini">]><RevitAddIns><AddIn Type="Application"><Assembly>&xxe;</Assembly></AddIn></RevitAddIns>',
    ],
    ['entity bomb', '<!DOCTYPE RevitAddIns [<!ENTITY a "boom">]><RevitAddIns>&a;</RevitAddIns>'],
    ['unknown namespace root', '<RevitAddIns xmlns="urn:unknown"/>'],
    [
      'duplicate field',
      `<RevitAddIns><AddIn Type="Application"><Name>n</Name><Assembly>one.dll</Assembly><Assembly>two.dll</Assembly><AddInId>${fixtureGuid}</AddInId><FullClassName>A.B</FullClassName></AddIn></RevitAddIns>`,
    ],
    ['zero id', fixtureXml('Plugin.dll', '00000000-0000-0000-0000-000000000000').toString()],
    ['malformed', '<RevitAddIns>malformed'],
    [
      'nested element',
      `<RevitAddIns><AddIn Type="Application"><Name>n</Name><Assembly><nested/></Assembly><AddInId>${fixtureGuid}</AddInId><FullClassName>A.B</FullClassName></AddIn></RevitAddIns>`,
    ],
    [
      'CDATA',
      `<RevitAddIns><AddIn Type="Application"><Name><![CDATA[x]]></Name></AddIn></RevitAddIns>`,
    ],
    ['unknown entity', fixtureXml('Plugin.dll').toString().replace('Synthetic', '&nbsp;')],
    [
      'Application without Name',
      fixtureXml('Plugin.dll')
        .toString()
        .replace(/<Name>[^<]*<\/Name>/, ''),
    ],
    [
      'duplicate AddInId',
      fixtureXml('Plugin.dll')
        .toString()
        .replace(/<RevitAddIns>([\s\S]*)<\/RevitAddIns>/, '<RevitAddIns>$1$1</RevitAddIns>'),
    ],
    ['empty', '<RevitAddIns></RevitAddIns>'],
  ])('refuses %s', (_name, text) => {
    expect(() => parseOwnAddin(Buffer.from(text))).toThrow();
  });
  it.each([
    '../foreign.dll',
    '/absolute.dll',
    'C:\\foreign.dll',
    '\\\\server\\foreign.dll',
    '%APPDATA%/foreign.dll',
    'Plugin/../../x.dll',
    'Plugin.exe',
    'file.dll:stream',
  ])('Assembly %s is not a path inside the build folder', (assembly) => {
    expect(() => resolveAssembly('2025/Plugin.addin', assembly)).toThrow();
  });
  it('Assembly resolves relative to the .addin folder of its year', () => {
    expect(resolveAssembly('2025/Plugin.addin', 'Plugin\\Plugin.dll')).toBe(
      '2025/Plugin/Plugin.dll',
    );
    expect(resolveAssembly('Plugin.addin', 'Plugin.dll')).toBe('Plugin.dll');
  });
  it('rendered .addin keeps fields, escapes text and points Assembly to the version folder', () => {
    const [entry] = parseOwnAddin(
      Buffer.from(
        `<RevitAddIns><AddIn Type="Application"><Name>A &lt;&amp;&gt; "B"</Name><Assembly>Plugin.dll</Assembly><AddInId>${fixtureGuid}</AddInId><FullClassName>Fixture.App</FullClassName></AddIn></RevitAddIns>`,
      ),
    );
    if (!entry) throw Error('fixture');
    const target = win32.join('C:/', 'Users', 'Иванова', 'Plugins', '1.0', 'Plugin.dll');
    const xml = renderAddin([{ entry, assemblyPath: target }]);
    expect(xml).toContain('<Name>A &lt;&amp;&gt; &quot;B&quot;</Name>');
    expect(xml).toContain(`<Assembly>${target}</Assembly>`);
    expect(parseOwnAddin(Buffer.from(xml))[0]?.assembly).toBe(target);
  });
});

describe('foreign .addin: soft reading never blocks', () => {
  it('Dynamo-like DBApplication with unknown tags still yields its AddInId', () => {
    const dynamo = Buffer.from(
      `<?xml version="1.0" encoding="utf-8" standalone="no"?>
<RevitAddIns>
  <AddIn Type="DBApplication">
    <Assembly>C:/Program Files/Dynamo/DynamoRevitVersionSelector.dll</Assembly>
    <AddInId>${second}</AddInId>
    <FullClassName>Dynamo.Applications.VersionLoader</FullClassName>
    <VendorId>ADSK</VendorId>
    <LoadInRevitWorksharingUI>True</LoadInRevitWorksharingUI>
    <Extra attr="x"><Nested/></Extra>
  </AddIn>
</RevitAddIns>`,
    );
    expect(softAddinEntries(dynamo)).toEqual([
      {
        addInId: second,
        assembly: 'C:/Program Files/Dynamo/DynamoRevitVersionSelector.dll',
      },
    ]);
  });
  it('commented-out entries do not count; garbage and binary give nothing, without throwing', () => {
    expect(
      softAddinEntries(
        Buffer.from(
          `<RevitAddIns><!-- <AddIn><AddInId>${second}</AddInId></AddIn> --></RevitAddIns>`,
        ),
      ),
    ).toEqual([]);
    expect(softAddinEntries(Buffer.from([0, 1, 2, 3, 255, 254, 0]))).toEqual([]);
    expect(softAddinEntries(Buffer.alloc(2 * 1024 * 1024, 65))).toEqual([]);
    expect(softAddinEntries(Buffer.from('<<<<&&&&'))).toEqual([]);
  });
});
