import { Screen } from "./ui";
import { APP_NAME } from "../lib/watermark/presets";

export default function AboutView() {
  return (
    <Screen title="About">
      <div className="card" style={{ padding: 16 }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>{APP_NAME}</h2>
        <p className="hint" style={{ fontSize: 14, lineHeight: 1.6 }}>
          A location-stamped camera for Chennai. Every photo carries GPS
          coordinates, ward, zone, and police-jurisdiction details resolved
          on your device — no internet needed to shoot.
        </p>
      </div>

      <div className="card" style={{ padding: 16 }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 15 }}>Coverage & accuracy</h2>
        <p className="hint" style={{ fontSize: 13, lineHeight: 1.7 }}>
          <strong>Boundaries are indicative. For official information always
          confirm with local police.</strong>
          <br />
          <br />
          Ward and zone data covers <strong>Greater Chennai Corporation</strong>{" "}
          (200 wards) and <strong>Tambaram Corporation</strong> (70 wards).
          <br />
          <br />
          <strong>Avadi Corporation</strong> ward boundaries are not yet
          available in the public dataset — photos taken there show the
          corporation name with ward marked “not yet available”. Ward support
          will appear automatically once the data lands; no app update needed.
          <br />
          <br />
          Police jurisdiction boundaries (Law &amp; Order and Traffic) cover
          the Chennai metropolitan area. Coverage inside Greater Chennai has
          been validated; Tambaram and Avadi coverage is present but not yet
          independently verified.
          <br />
          <br />
          Outside these three corporations the app deliberately shows only raw
          GPS coordinates — ward and police fields are hidden rather than
          risking wrong data.
        </p>
      </div>

      <div className="card" style={{ padding: 16 }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 15 }}>Privacy</h2>
        <p className="hint" style={{ fontSize: 13, lineHeight: 1.7 }}>
          Photos, videos, and your profile stay on this device. Nothing is
          uploaded unless you explicitly share a file. The only network
          requests are the optional background address lookup and map
          thumbnail fetch.
          <br />
          <br />
          Automatic face / licence-plate blurring is best-effort and can miss
          things — always review blur regions yourself before sharing. It is
          not a guarantee of anonymisation. The experimental live face blur
          burns into photos at capture; video clips record raw and are
          blurred only when exported.
        </p>
      </div>

      <div className="card" style={{ padding: 16 }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 15 }}>Data sources</h2>
        <p className="hint" style={{ fontSize: 13, lineHeight: 1.7 }}>
          Jurisdiction boundaries derived from public Tamil Nadu government
          data, processed by the Reclaim Chennai project. Optional street
          addresses courtesy of{" "}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
            © OpenStreetMap contributors
          </a>{" "}
          (or Google, if configured). Map thumbnails on photos are the app's
          own rendering of boundary data unless labelled “Google”.
        </p>
      </div>

      <p className="hint" style={{ textAlign: "center", padding: 8 }}>
        Part of the{" "}
        <a href="https://reclaimchennai.city" target="_blank" rel="noopener noreferrer">
          Reclaim Chennai
        </a>{" "}
        civic-tech family
        <br />
        <span style={{ fontSize: 11 }}>
          Build {__BUILD_TS__.slice(0, 16).replace("T", " ")} UTC — updates
          install automatically
        </span>
      </p>
    </Screen>
  );
}
