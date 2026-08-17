import { expect } from 'chai';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Proves the tarball and the package page metadata before a tag exists, so a
// files or package.json regression cannot ship behind green unit tests. The
// pretest hook builds dist first.

const root = path.join(__dirname, '..');

interface PackReport {
    files: Array<{ path: string }>;
}

// npm 11 emits an array of reports; npm 12 emits an object keyed by package name.
function readPackReport(stream: string): PackReport {
    const parsed: unknown = JSON.parse(stream);
    const members = Array.isArray(parsed) ? parsed : Object.values(parsed as Record<string, unknown>);
    const report = members.find((member) => Array.isArray((member as PackReport)?.files));

    if (!report) {
        throw new Error(`npm pack emitted no report carrying a file list: ${stream}`);
    }

    return report as PackReport;
}

describe('Packaging', function () {
    this.timeout(30000);

    it('npm pack ships only the build output, the notices, the changelog and the manifest', () => {
        const output = execSync('npm pack --dry-run --json --ignore-scripts', {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const files = readPackReport(output).files.map((file) => file.path);

        expect(files).to.include.members(['LICENSE', 'NOTICE', 'CHANGELOG.md', 'README.md', 'package.json']);
        expect(files).to.include('dist/index.js');
        expect(files).to.include('dist/index.d.ts');
        expect(files).to.include('dist/deserializer/worker.js');

        for (const file of files) {
            expect(
                /^(LICENSE|NOTICE|CHANGELOG\.md|README\.md|package\.json)$|^dist\//.test(file),
                `unexpected file in tarball: ${file}`
            ).to.equal(true);
        }

        expect(files.some((file) => /\.test\.(js|d\.ts)$/.test(file)), 'test files leaked into dist').to.equal(false);
    });

    it('the CommonJS entry loads and exposes the runtime surface', () => {
        const entry = require(path.join(root, 'dist', 'index.js'));

        for (const name of [
            'StateHistoryConnection',
            'ShipConsumer',
            'BlockProcessor',
            'EOSJsDeserializer',
            'LocalAbiProvider',
            'LocalBlockRepository',
        ]) {
            expect(entry[name], name).to.be.a('function');
        }
    });

    it('package.json carries the published metadata the package page reads', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

        expect(manifest.name).to.equal('@atomichub/antelope-ship-utils');
        expect(manifest.description).to.be.a('string').and.not.equal('');
        expect(manifest.license).to.equal('MIT');
        expect(manifest.homepage).to.be.a('string');
        expect(manifest.repository).to.deep.equal({
            type: 'git',
            url: 'git+https://github.com/atomicassets/antelope-ship-utils.git',
        });
        expect(manifest.bugs).to.deep.equal({ url: 'https://github.com/atomicassets/antelope-ship-utils/issues' });
        expect(manifest.author).to.deep.equal({ name: 'AtomicHub', url: 'https://atomichub.io' });
        expect(manifest.keywords).to.be.an('array').and.not.empty;
        expect(manifest.engines).to.deep.equal({ node: '>=22' });
        expect(manifest.main).to.equal('./dist/index.js');
        expect(manifest.types).to.equal('./dist/index.d.ts');
        expect(manifest.exports['.']).to.deep.equal({ types: './dist/index.d.ts', default: './dist/index.js' });
        expect(manifest.files).to.deep.equal(['dist/', 'NOTICE', 'CHANGELOG.md']);
        expect(manifest.sideEffects).to.equal(false);
        expect(manifest.publishConfig).to.deep.equal({ access: 'public', provenance: true });
    });

    it('every path the exports map names exists in dist', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        const entry = manifest.exports['.'] as Record<string, string>;

        for (const target of Object.values(entry)) {
            expect(fs.existsSync(path.join(root, target)), target).to.equal(true);
        }
    });
});
