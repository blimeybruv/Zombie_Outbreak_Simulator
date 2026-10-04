import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Milestone 1 gate, made mechanical: every field of every state interface declares
// a range, a unit, and at least one reader. A field with no @readBy is a field
// nothing reads, and does not belong in the state.

const stateDir = join(import.meta.dirname, '../src/sim/state');
const REQUIRED = ['range', 'unit', 'readBy'] as const;

interface Field {
  location: string;
  tags: Map<string, string>;
}

function collectFields(): Field[] {
  const fields: Field[] = [];
  for (const file of readdirSync(stateDir).filter((f) => f.endsWith('.ts'))) {
    const source = ts.createSourceFile(file, readFileSync(join(stateDir, file), 'utf8'), ts.ScriptTarget.ES2022, true);
    source.forEachChild((node) => {
      if (!ts.isInterfaceDeclaration(node)) return;
      for (const member of node.members) {
        if (!ts.isPropertySignature(member)) continue;
        const tags = new Map<string, string>();
        for (const tag of ts.getJSDocTags(member)) {
          const text = ts.getTextOfJSDocComment(tag.comment)?.trim() ?? '';
          tags.set(tag.tagName.text, text);
        }
        fields.push({ location: `${file} ${node.name.text}.${member.name.getText(source)}`, tags });
      }
    });
  }
  return fields;
}

describe('state shape gate', () => {
  const fields = collectFields();

  it('finds the state interfaces', () => {
    expect(fields.length).toBeGreaterThan(100);
  });

  it.each(REQUIRED)('every field declares a non-empty @%s', (tag) => {
    const missing = fields.filter((f) => !f.tags.get(tag)).map((f) => f.location);
    expect(missing).toEqual([]);
  });
});
