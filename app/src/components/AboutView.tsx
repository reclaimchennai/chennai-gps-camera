import { useEffect, useState } from "react";
import { Screen } from "./ui";
import { APP_NAME } from "../lib/watermark/presets";
import { nativeAppVersion } from "../lib/native";

export default function AboutView() {
  const [apkVersion, setApkVersion] = useState<string | null>(null);
  useEffect(() => {
    void nativeAppVersion().then(setApkVersion);
  }, []);
  return (
    <Screen title="About">
      <div className="card" style={{ padding: 16 }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>{APP_NAME}</h2>
        <p className="hint" style={{ fontSize: 14, lineHeight: 1.6 }}>
          A location-stamped camera born in Chennai, covering all of Tamil
          Nadu and major Indian cities. Every photo carries GPS coordinates,
          ward, zone, and police-jurisdiction details resolved on your
          device — no internet needed to shoot.
        </p>
      </div>

      <div className="card" style={{ padding: 16 }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 15 }}>Coverage & accuracy</h2>
        <p className="hint" style={{ fontSize: 13, lineHeight: 1.7 }}>
          <strong>Boundaries are indicative. For official information always
          confirm with local authorities.</strong>
          <br />
          <br />
          Ward, zone and (where published) police-jurisdiction data currently
          covers: <strong>all of Tamil Nadu</strong> (every corporation,
          municipality and town panchayat, statewide L&amp;O and Traffic
          police), <strong>Bengaluru</strong> (GBA wards + city &amp; traffic
          police), <strong>Hyderabad</strong> (GHMC + police),{" "}
          <strong>Delhi</strong> (MCD wards), <strong>Kolkata</strong> (KMC
          wards + police stations), <strong>Mumbai</strong> (BMC wards +
          police), <strong>Pune</strong> (PMC wards) and{" "}
          <strong>Visakhapatnam</strong> (GVMC wards). Region data downloads
          automatically for wherever you are and updates over the air.
          <br />
          <br />
          <strong>Avadi Corporation</strong> ward boundaries are not yet
          published — photos there show the corporation with ward marked “not
          yet available”. Chennai-area coverage is the validated pilot; other
          regions carry the same “indicative” caveat.
          <br />
          <br />
          Outside covered regions the app shows only what is always accurate:
          raw GPS coordinates, DIGIPIN and the street address — jurisdiction
          fields are hidden rather than risking wrong data.
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
          burns into photos at capture and into video files as they record.
        </p>
      </div>

      <div className="card" style={{ padding: 16 }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 15 }}>Data sources</h2>
        <p className="hint" style={{ fontSize: 13, lineHeight: 1.7 }}>
          Tamil Nadu jurisdiction boundaries derived from public government
          data, processed by the Reclaim Chennai project. Bengaluru, Delhi,
          Hyderabad, Kolkata, Mumbai, Pune and Visakhapatnam boundaries from{" "}
          <a
            href="https://github.com/Vonter/city-officials"
            target="_blank"
            rel="noopener noreferrer"
          >
            Vonter/city-officials
          </a>{" "}
          (GPL-3.0, visualised at cityofficials.bengawalk.com), built on
          datasets published at{" "}
          <a
            href="https://data.opencity.in"
            target="_blank"
            rel="noopener noreferrer"
          >
            OpenCity
          </a>{" "}
          and the respective government sources. Optional street addresses
          courtesy of{" "}
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
          {apkVersion && (
            <>
              <br />
              Android app v{apkVersion}
            </>
          )}
        </span>
      </p>
    </Screen>
  );
}
