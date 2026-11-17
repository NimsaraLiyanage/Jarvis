// Added by the desktop app's preload script; absent in a normal browser.
interface Window {
  onyxDesktop?: {
    // Brings the Onyx window forward, even from the tray.
    show: () => void;
  };
}
