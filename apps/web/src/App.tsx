import { parseScene, summarizeScene } from '@flat/scene';
import sample from '@flat/scene/fixtures/sample.flat.json';

const result = parseScene(sample);

export function App() {
  if (!result.ok) {
    return (
      <main>
        <h1>Invalid flat</h1>
        <ul className="errors">
          {result.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </main>
    );
  }

  const summary = summarizeScene(result.scene);
  return (
    <main>
      <h1>{summary.name}</h1>
      <p>
        {summary.wallCount} walls · {summary.doorCount} doors · {summary.windowCount} windows ·{' '}
        {summary.lightCount} lights
      </p>
      <table>
        <thead>
          <tr>
            <th>Room</th>
            <th>Type</th>
            <th>Area (m²)</th>
          </tr>
        </thead>
        <tbody>
          {summary.rooms.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>{r.type}</td>
              <td className="num">{r.area.toFixed(2)}</td>
            </tr>
          ))}
          <tr>
            <th colSpan={2}>Total</th>
            <th className="num">{summary.totalArea.toFixed(2)}</th>
          </tr>
        </tbody>
      </table>
    </main>
  );
}
