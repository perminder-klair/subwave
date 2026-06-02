// Renders a Schema.org JSON-LD block. Accepts a single node or an array of
// nodes (emitted as one script each). Data is first-party and static, so the
// dangerouslySetInnerHTML passthrough is not an injection vector here.
export default function JsonLd({ data }: { data: object | object[] }) {
  const nodes = Array.isArray(data) ? data : [data];
  return (
    <>
      {nodes.map((node, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(node) }}
        />
      ))}
    </>
  );
}
