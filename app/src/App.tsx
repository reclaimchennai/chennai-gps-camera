import { lazy, Suspense } from "react";
import { useRoute } from "./nav";
import CameraView from "./components/CameraView";
import GalleryView from "./components/GalleryView";
import MediaDetailView from "./components/MediaDetailView";
import SettingsView from "./components/SettingsView";
import WatermarkEditorView from "./components/WatermarkEditorView";
import AboutView from "./components/AboutView";
import ReportView from "./components/ReportView";

// Konva-based editors are heavy and never needed at cold start — keep
// them out of the critical bundle (§10: launch-to-camera under ~1 s).
const PhotoEditorView = lazy(() => import("./components/PhotoEditorView"));
const VideoEditorView = lazy(() => import("./components/VideoEditorView"));

export default function App() {
  const route = useRoute();

  // CameraView stays mounted permanently so the stream survives
  // navigation and returning to the viewfinder is instant (§2).
  return (
    <>
      <CameraView active={route.name === "camera"} />
      {route.name === "gallery" && <GalleryView />}
      {route.name === "media" && route.id && <MediaDetailView id={route.id} />}
      <Suspense fallback={null}>
        {route.name === "edit" && route.id && <PhotoEditorView id={route.id} />}
        {route.name === "video-edit" && route.id && (
          <VideoEditorView id={route.id} />
        )}
      </Suspense>
      {route.name === "settings" && <SettingsView />}
      {route.name === "watermark" && <WatermarkEditorView />}
      {route.name === "about" && <AboutView />}
      {route.name === "report" && <ReportView />}
    </>
  );
}
