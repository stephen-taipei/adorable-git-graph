import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { detectLocale } from '@adorable/graph-ui';
import type { TabCommand } from '../shared/messages';
import { Fab } from './Fab';
import { Overlay } from './Overlay';
import { repoStore } from './repoStore';

export function App() {
  const repo = useSyncExternalStore(repoStore.subscribe, repoStore.getSnapshot);
  const [open, setOpen] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open)
      document
        .getElementById('adorable-git-graph-host')
        ?.shadowRoot?.querySelector<HTMLElement>('.agg-fab')
        ?.focus();
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    const onMessage = (msg: unknown) => {
      if ((msg as TabCommand | undefined)?.type === 'toggle') setOpen((o) => !o);
      if ((msg as TabCommand | undefined)?.type === 'data-invalidated') setEpoch((e) => e + 1);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  if (!repo) return null;
  const label = detectLocale() === 'zh-TW' ? '開啟 Git Graph' : 'Open Git Graph';
  return open ? (
    <Overlay repo={repo} onClose={close} epoch={epoch} />
  ) : (
    <Fab label={label} onClick={() => setOpen(true)} />
  );
}
