/** Lays services out in columns by dependency depth: a service sits left of
 *  everything it connects to, so links run left to right across the gaps.
 *  Returns null when nothing is linked, and the canvas wraps a plain grid. */
export function dependencyColumns<T extends { name: string; dependsOn: string[] }>(nodes: T[]): T[][] | null {
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const linked = nodes.some((n) => n.dependsOn.some((d) => byName.has(d)));
  if (!linked) return null;

  const depth = new Map<string, number>();
  const visit = (n: T, path: Set<string>): number => {
    const known = depth.get(n.name);
    if (known !== undefined) return known;
    if (path.has(n.name)) return 0; // a cycle: break it here
    path.add(n.name);
    const deps = n.dependsOn.flatMap((d) => byName.get(d) ?? []);
    const d = deps.length ? 1 + Math.max(...deps.map((dep) => visit(dep, path))) : 0;
    path.delete(n.name);
    depth.set(n.name, d);
    return d;
  };
  nodes.forEach((n) => visit(n, new Set()));

  const max = Math.max(...depth.values());
  const columns: T[][] = Array.from({ length: max + 1 }, () => []);
  for (const n of nodes) columns[max - depth.get(n.name)!].push(n);
  return columns;
}
