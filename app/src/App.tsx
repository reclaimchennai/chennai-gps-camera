import { lazy, Suspense } from "react";
import { useRoute } from "./nav";
import CameraView from "./components/CameraView";
import GalleryView from "./components/GalleryView";
import VideoGroupView from "./components/VideoGroupView";
import MediaDetailView from "./components/MediaDetailView";
import SettingsView from "./components/SettingsView";
import WatermarkEditorView from "./components/WatermarkEditorView";
import AboutView from "./components/AboutView";

// Konva-based editors are heavy and never needed at cold start — keep
// them out of the critical bundle (§10: launch-to-camera under ~1 s).
const PhotoEditorView = lazy(() => import("./components/PhotoEditorView"));
const VideoEditorView = lazy(() => import("./components/VideoEditorView"));
// Report screen is rarely opened — keep it out of the cold-start bundle.
const ReportView = lazy(() => import("./components/ReportView"));
// Leaflet + plugins are heavy — the photo map loads on demand.
const PhotoMapView = lazy(() => import("./components/PhotoMapView"));

export default function App() {
  const route = useRoute();

  // CameraView stays mounted permanently so the stream survives
  // navigation and returning to the viewfinder is instant (§2).
  return (
    <>
      <CameraView active={route.name === "camera"} />
      {route.name === "gallery" && <GalleryView />}
      {route.name === "group" && route.id && <VideoGroupView id={route.id} />}
      <Suspense fallback={null}>
        {route.name === "map" && <PhotoMapView />}
      </Suspense>
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
      <Suspense fallback={null}>
        {route.name === "report" && <ReportView />}
      </Suspense>
    </>
  );
}
