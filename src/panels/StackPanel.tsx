import { useEffect, useState } from 'react';
import { InputNumber } from '@/components/InputNumber';
import { useSceneStore } from '@/scene/store';
import type { Modifier, SceneNode } from '@/scene/types';
import { type OpDescriptor, type OpParamSpec, useOpsCacheStore } from '@/sidecar/opsCache';

/**
 * Debug modifier panel (cook-pipeline.md) — deliberately unstyled. Exists so
 * the epic Hill is testable end-to-end (import -> add blur -> scrub radius)
 * and so `list_ops`-driven UI generation is proven before Epic 04 makes it
 * good. No enum-type ops exist in the starter set, so enum params render as
 * a disabled placeholder rather than invent an options field the sidecar
 * doesn't send yet.
 */

function defaultParamsFor(descriptor: OpDescriptor): Modifier['params'] {
  const params: Modifier['params'] = {};
  for (const p of descriptor.params) params[p.name] = p.default as number | string | boolean;
  return params;
}

function ParamControl({
  spec,
  value,
  onChange,
}: {
  spec: OpParamSpec;
  value: number | string | boolean;
  onChange: (value: number | string | boolean) => void;
}) {
  if (spec.type === 'float' || spec.type === 'int') {
    return (
      <InputNumber
        label={spec.name}
        value={typeof value === 'number' ? value : Number(value) || 0}
        onChange={onChange}
        min={spec.min}
        max={spec.max}
        step={spec.step ?? (spec.type === 'int' ? 1 : 0.1)}
      />
    );
  }
  if (spec.type === 'bool') {
    return (
      <label>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        {spec.name}
      </label>
    );
  }
  if (spec.type === 'enum' && spec.choices) {
    return (
      <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        {spec.name}
        <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {spec.choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      </label>
    );
  }
  // enum with no choices sent: honest read-only fallback.
  return (
    <span>
      {spec.name}: {String(value)}
    </span>
  );
}

function ModifierRow({
  node,
  modifier,
  index,
  ops,
}: {
  node: SceneNode;
  modifier: Modifier;
  index: number;
  ops: OpDescriptor[];
}) {
  const setModifierParam = useSceneStore((s) => s.setModifierParam);
  const setModifierEnabled = useSceneStore((s) => s.setModifierEnabled);
  const removeModifier = useSceneStore((s) => s.removeModifier);
  const reorderModifier = useSceneStore((s) => s.reorderModifier);

  const descriptor = ops.find((o) => o.name === modifier.type);
  const last = node.modifiers.length - 1;

  return (
    <div style={{ border: '1px solid #444', padding: 4, marginBottom: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={modifier.enabled}
          onChange={(e) => setModifierEnabled(node.id, modifier.id, e.target.checked)}
        />
        <strong>{modifier.type}</strong>
        {/* List order IS application order: row 0 cooks first. */}
        <button
          type="button"
          disabled={index === 0}
          onClick={() => reorderModifier(node.id, modifier.id, index - 1)}
        >
          ↑
        </button>
        <button
          type="button"
          disabled={index === last}
          onClick={() => reorderModifier(node.id, modifier.id, index + 1)}
        >
          ↓
        </button>
        <button type="button" onClick={() => removeModifier(node.id, modifier.id)}>
          Remove
        </button>
      </div>
      {descriptor?.params.map((spec) => (
        <ParamControl
          key={spec.name}
          spec={spec}
          value={modifier.params[spec.name] ?? spec.default}
          onChange={(value) => setModifierParam(node.id, modifier.id, spec.name, value)}
        />
      ))}
    </div>
  );
}

function AddModifierRow({ node, ops }: { node: SceneNode; ops: OpDescriptor[] }) {
  const addModifier = useSceneStore((s) => s.addModifier);
  const [selected, setSelected] = useState(ops[0]?.name ?? '');

  useEffect(() => {
    if (!selected && ops.length > 0) setSelected(ops[0].name);
  }, [selected, ops]);

  if (ops.length === 0) {
    return <div>No ops available (sidecar not connected yet)</div>;
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <select value={selected} onChange={(e) => setSelected(e.target.value)}>
        {ops.map((op) => (
          <option key={op.name} value={op.name}>
            {op.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => {
          const descriptor = ops.find((o) => o.name === selected);
          if (descriptor) addModifier(node.id, descriptor.name, defaultParamsFor(descriptor));
        }}
      >
        Add modifier
      </button>
    </div>
  );
}

export function StackPanel() {
  const nodes = useSceneStore((s) => s.scene.nodes);
  const ops = useOpsCacheStore((s) => s.ops);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedNodeId && nodes.some((n) => n.id === selectedNodeId)) return;
    setSelectedNodeId(nodes[0]?.id ?? null);
  }, [nodes, selectedNodeId]);

  if (nodes.length === 0) {
    return <div className="text-neutral-500 text-sm">No layers yet — import an image.</div>;
  }

  const node = nodes.find((n) => n.id === selectedNodeId) ?? nodes[0];

  return (
    <div
      className="text-neutral-200 text-sm"
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <select value={node.id} onChange={(e) => setSelectedNodeId(e.target.value)}>
        {nodes.map((n) => (
          <option key={n.id} value={n.id}>
            {n.label}
          </option>
        ))}
      </select>

      {node.modifiers.map((modifier, index) => (
        <ModifierRow key={modifier.id} node={node} modifier={modifier} index={index} ops={ops} />
      ))}

      <AddModifierRow node={node} ops={ops} />
    </div>
  );
}
