import { createRoot } from 'react-dom/client';
import { viewerCss } from '@adorable/graph-ui';
import { App } from './App';
import { ANIMATION_OFF_KEY } from './useAnimationOff';
import { DETAIL_SIZE_KEY } from './useDetailSize';
import { preloadExtensionSettings } from './useExtensionSetting';
import { THEME_ID_KEY } from './useThemeId';
import overlayCss from './styles.css?inline';
// 三個主題的樣式都 inline 進 content script（extension 不能像 web 一樣按需載入外部 CSS）；
// 每個主題的樣式都限定在 [data-theme-id='<id>']，同時存在不會互相影響。
import candyCss from '@adorable/graph-ui/themes/candy.css?inline';
import hackerCss from '@adorable/graph-ui/themes/hacker.css?inline';
import halloweenCss from '@adorable/graph-ui/themes/halloween.css?inline';

const HOST_ID = 'adorable-git-graph-host';

function mount() {
  if (document.getElementById(HOST_ID)) return;

  // 掛在 <html> 底下：GitHub(Turbo) 換頁時會整個替換 <body>。
  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  const css = [overlayCss, viewerCss, candyCss, hackerCss, halloweenCss].join('\n');
  try {
    // constructable stylesheet 不受頁面 CSP style-src 影響
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = css;
    shadow.append(style);
  }
  const app = document.createElement('div');
  shadow.append(app);

  // 避免 GitHub 的全域快捷鍵（g / t / s / `/` …）在 overlay 內被觸發：事件在 shadow host 就擋下來，
  // 不會冒泡到頁面的 document / window（overlay 內的搜尋框與列表快捷鍵都靠這個才不會誤觸 GitHub）。
  // Esc 也一樣擋：由 overlay 自己處理（見 Overlay.tsx）。
  for (const type of ['keydown', 'keyup', 'keypress'] as const) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  document.documentElement.append(host);
  // overlay 的偏好設定先讀好再 render：第一次打開就是存過的值（「關閉動畫」不會先播一段動畫）。
  // storage 沒回應也不能讓浮動按鈕一直不出現，最多等 1 秒。
  const ready = Promise.race([
    preloadExtensionSettings([ANIMATION_OFF_KEY, DETAIL_SIZE_KEY, THEME_ID_KEY]),
    new Promise<void>((resolve) => setTimeout(resolve, 1000)),
  ]);
  void ready.then(() => createRoot(app).render(<App />));
}

mount();
