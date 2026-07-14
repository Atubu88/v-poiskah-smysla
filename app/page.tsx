"use client";

import { useEffect, useMemo, useState } from "react";
import { stages, totalTasks, type JourneyStage, type JourneyTask } from "../lib/journey";

type Tab = "home" | "path" | "progress" | "about";
type Phase = "intro" | "task" | "conclusion";
type Progress = {
  completedStages: string[];
  completedTasks: string[];
  reflections: Record<string, number[]>;
};
type TelegramUser = {
  id: number;
  first_name?: string;
  username?: string;
};

type TelegramWebAppUnsafeData = {
  user?: TelegramUser;
};

type TelegramWebApp = {
  initData?: string;
  initDataUnsafe?: TelegramWebAppUnsafeData;
  colorScheme?: string;
  ready: () => void;
  expand: () => void;
  openTelegramLink?: (url: string) => void;
  BackButton: { show: () => void; hide: () => void; onClick: (fn: () => void) => void };
  HapticFeedback?: { notificationOccurred: (type: string) => void };
};

const STORAGE_KEY = "meaning-journey-v2";
const TELEGRAM_IDENTIFY_KEY = "meaning-journey-telegram-identify-v1";
const initialProgress: Progress = { completedStages: [], completedTasks: [], reflections: {} };
const tg = () => typeof window === "undefined" ? undefined : (window as typeof window & { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;

const nav: { id: Tab; label: string; icon: string }[] = [
  { id: "home", label: "Главная", icon: "⌂" },
  { id: "path", label: "Путь", icon: "◇" },
  { id: "progress", label: "Прогресс", icon: "↗" },
  { id: "about", label: "О пути", icon: "○" },
];

function uniq(values: string[]) { return Array.from(new Set(values)); }

export default function Home() {
  const [tab, setTab] = useState<Tab>("home");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [progress, setProgress] = useState<Progress>(initialProgress);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [toast, setToast] = useState("");
  const active = stages.find(stage => stage.id === activeId) ?? null;

  useEffect(() => {
    const app = tg();
    let cancelled = false;
    let attemptCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const identifyTelegramUser = async () => {
      if (cancelled) return;

      const currentApp = tg();
      const user = currentApp?.initDataUnsafe?.user;
      const initData = currentApp?.initData || "";
      const identifyKey = user?.id ? `${TELEGRAM_IDENTIFY_KEY}:${user.id}` : null;

      if (identifyKey && sessionStorage.getItem(identifyKey) === "done") {
        return;
      }

      if (user?.id && initData) {
        try {
          const response = await fetch("/api/telegram/identify", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ user, initData }),
          });

          if (response.ok) {
            if (identifyKey) sessionStorage.setItem(identifyKey, "done");
            return;
          }
        } catch {
          // Retry below.
        }
      }

      attemptCount += 1;
      if (attemptCount < 6 && !cancelled) {
        retryTimer = setTimeout(identifyTelegramUser, 400 * attemptCount);
      }
    };

    queueMicrotask(() => {
      if (app?.initData) {
        app.ready();
        app.expand();
        setTheme(app.colorScheme === "dark" ? "dark" : "light");
        app.BackButton.onClick(() => setActiveId(null));
        void identifyTelegramUser();
      } else {
        setTheme(matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      }
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) setProgress({ ...initialProgress, ...JSON.parse(saved) });
      } catch { localStorage.removeItem(STORAGE_KEY); }
      setHydrated(true);
    });

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    if (hydrated) localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
    const app = tg();
    if (app?.initData) {
      if (active) app.BackButton.show();
      else app.BackButton.hide();
    }
  }, [theme, progress, hydrated, active]);

  function go(next: Tab) {
    setActiveId(null);
    setTab(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function isUnlocked(stage: JourneyStage) {
    return stage.number === 1 || progress.completedStages.includes(stages[stage.number - 2].id);
  }

  function openStage(id: string) {
    const stage = stages.find(item => item.id === id);
    if (!stage || !isUnlocked(stage)) return;
    setActiveId(id);
    setTab("path");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function recordTask(stage: JourneyStage, task: JourneyTask, selected: number[], solved: boolean) {
    setProgress(current => {
      return {
        ...current,
        completedTasks: uniq([...current.completedTasks, task.id]),
        reflections: task.kind === "reflection" ? { ...current.reflections, [task.id]: selected } : current.reflections,
      };
    });
    const app = tg();
    if (app?.initData) app.HapticFeedback?.notificationOccurred(solved ? "success" : "warning");
  }

  function completeStage(stage: JourneyStage) {
    setProgress(current => ({ ...current, completedStages: uniq([...current.completedStages, stage.id]) }));
  }

  function resetProgress() {
    if (confirm("Начать путь заново и удалить сохранённый прогресс?")) {
      setProgress(initialProgress);
      setActiveId(null);
      setToast("Путь начат заново");
      setTimeout(() => setToast(""), 2200);
    }
  }

  async function shareJourney() {
    const completed = progress.completedStages.length;
    const text = completed === stages.length
      ? "Я прошёл интерактивный путь «В поисках смысла» — от вопроса о счастье к смыслу принятия Ислама."
      : `Я прохожу «В поисках смысла»: ${completed} из ${stages.length} этапов.`;
    const url = location.origin + location.pathname;
    try {
      const app = tg();
      if (app?.initData && app.openTelegramLink) app.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`);
      else if (navigator.share) await navigator.share({ title: "В поисках смысла", text, url });
      else {
        await navigator.clipboard.writeText(`${text} ${url}`);
        setToast("Ссылка скопирована");
        setTimeout(() => setToast(""), 2200);
      }
    } catch { /* пользователь отменил системный диалог */ }
  }

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={() => go("home")} aria-label="На главную">
        <span className="brand-mark">С</span><span>В поисках смысла</span>
      </button>
      <button className="icon-button" onClick={() => setTheme(value => value === "light" ? "dark" : "light")} aria-label="Переключить тему">
        {theme === "light" ? "☾" : "☀"}
      </button>
    </header>

    <main>
      {active
        ? <StageView
            key={active.id}
            stage={active}
            progress={progress}
            onRecord={recordTask}
            onComplete={completeStage}
            onClose={() => setActiveId(null)}
            onNext={() => {
              const next = stages[active.number];
              if (next) openStage(next.id); else { setActiveId(null); setTab("progress"); }
            }}
            onShare={shareJourney}
          />
        : <>
            {tab === "home" && <HomeView progress={progress} onOpen={openStage} onPath={() => go("path")} />}
            {tab === "path" && <PathView progress={progress} onOpen={openStage} />}
            {tab === "progress" && <ProgressView progress={progress} onOpen={openStage} onShare={shareJourney} />}
            {tab === "about" && <AboutView onReset={resetProgress} />}
          </>}
    </main>

    {!active && <nav className="bottom-nav" aria-label="Основное меню">
      {nav.map(item => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => go(item.id)}><span>{item.icon}</span>{item.label}</button>)}
    </nav>}
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}

function HomeView({ progress, onOpen, onPath }: { progress: Progress; onOpen: (id: string) => void; onPath: () => void }) {
  const completed = progress.completedStages.length;
  const next = stages.find(stage => !progress.completedStages.includes(stage.id)) ?? stages[stages.length - 1];
  const nextUnlocked = next.number === 1 || progress.completedStages.includes(stages[next.number - 2].id);
  const pct = Math.round(completed / stages.length * 100);

  return <>
    <section className="hero">
      <div className="eyebrow"><span /> Путь к главным вопросам</div>
      <h1>В поисках<br /><em>смысла</em></h1>
      <p>Не экзамен на знания. Последовательное размышление о счастье, Создателе, Послании и Коране.</p>
      <button className="primary big" onClick={() => onOpen(nextUnlocked ? next.id : stages[0].id)}>
        {completed ? "Продолжить путь" : "Начать путь"} <span>→</span>
      </button>
      <div className="hero-note"><span>✓</span> 8 этапов · прямой разговор · прогресс сохраняется</div>
      <div className="hero-orbit" aria-hidden="true">
        <span className="orbit-a">Нужда</span><span className="orbit-b">Знамение</span><span className="orbit-c">Послание</span><div>?</div>
      </div>
    </section>

    <section className="dashboard section-wrap">
      <div className="section-heading">
        <div><span className="kicker">Следующий этап</span><h2>{completed === stages.length ? "Путь пройден" : next.shortTitle}</h2></div>
        <button className="text-button" onClick={onPath}>Весь маршрут →</button>
      </div>
      <button className="next-card" onClick={() => onOpen(next.id)}>
        <div><span className="chapter-pill">Этап {String(next.number).padStart(2, "0")} из {stages.length}</span><h3>{next.title}</h3><p>{next.duration} · {next.tasks.length} последовательных шагов</p></div>
        <span className="round-arrow">→</span>
      </button>

      <div className="stats-grid">
        <article><span className="stat-icon green">✓</span><div><b>{completed}/{stages.length}</b><p>этапов завершено</p></div></article>
        <article><span className="stat-icon gold">◇</span><div><b>{progress.completedTasks.length}/{totalTasks}</b><p>размышлений пройдено</p></div></article>
        <article><div className="ring" style={{ "--p": `${pct * 3.6}deg` } as React.CSSProperties}><span>{pct}%</span></div><div><b>Путь</b><p>общий прогресс</p></div></article>
      </div>

      <div className="section-heading"><div><span className="kicker">Маршрут размышления</span><h2>От нехватки — к доверию</h2></div></div>
      <div className="route-preview">
        {stages.slice(0, 4).map(stage => <button key={stage.id} onClick={() => onOpen(stage.id)} disabled={stage.number > completed + 1}>
          <span>{String(stage.number).padStart(2, "0")}</span><h3>{stage.title}</h3><p>{stage.intro}</p>
        </button>)}
      </div>

      <div className="method-strip">
        <span>Как проходит этап</span>
        <div><b>01</b><p>Личная точка</p></div><div><b>02</b><p>Наблюдение</p></div><div><b>03</b><p>Проверка мысли</p></div><div><b>04</b><p>Новый вопрос</p></div>
      </div>
    </section>
  </>;
}

function PathView({ progress, onOpen }: { progress: Progress; onOpen: (id: string) => void }) {
  return <section className="page section-wrap">
    <div className="page-intro"><span className="kicker">Один связный маршрут</span><h1>Путь из восьми этапов</h1><p>Каждый вопрос рождается из предыдущего. Пройденные этапы можно открывать повторно, следующий появляется после завершения текущего.</p></div>
    <div className="journey-map">
      {stages.map((stage, index) => {
        const done = progress.completedStages.includes(stage.id);
        const unlocked = index === 0 || progress.completedStages.includes(stages[index - 1].id);
        const current = unlocked && !done;
        return <article key={stage.id} className={`${done ? "done" : ""} ${current ? "current" : ""} ${!unlocked ? "locked" : ""}`}>
          <div className="map-line"><span>{done ? "✓" : String(stage.number).padStart(2, "0")}</span><i /></div>
          <div className="map-card">
            <div><span className="chapter-pill">Этап {String(stage.number).padStart(2, "0")}</span><small>{stage.duration}</small></div>
            <h2>{stage.title}</h2><p>{stage.intro}</p>
            <button onClick={() => onOpen(stage.id)} disabled={!unlocked}>{done ? "Пройти ещё раз" : current ? "Открыть этап" : "Сначала предыдущий"} {unlocked && "→"}</button>
          </div>
        </article>;
      })}
    </div>
  </section>;
}

function StageView({ stage, progress, onRecord, onComplete, onClose, onNext, onShare }: {
  stage: JourneyStage;
  progress: Progress;
  onRecord: (stage: JourneyStage, task: JourneyTask, selected: number[], solved: boolean) => void;
  onComplete: (stage: JourneyStage) => void;
  onClose: () => void;
  onNext: () => void;
  onShare: () => void;
}) {
  const firstIncomplete = stage.tasks.findIndex(task => !progress.completedTasks.includes(task.id));
  const initialTaskIndex = firstIncomplete < 0 ? 0 : firstIncomplete;
  const [phase, setPhase] = useState<Phase>("intro");
  const [taskIndex, setTaskIndex] = useState(initialTaskIndex);
  const [selected, setSelected] = useState<number[]>(progress.reflections[stage.tasks[initialTaskIndex].id] ?? []);
  const [checked, setChecked] = useState(false);
  const task = stage.tasks[taskIndex];
  const isComplete = progress.completedStages.includes(stage.id);

  const solved = useMemo(() => {
    if (!task || task.kind === "reflection") return true;
    const correct = task.correct ?? [];
    return selected.length === correct.length && [...selected].sort().every((value, index) => value === [...correct].sort()[index]);
  }, [task, selected]);

  function begin() {
    const nextIndex = firstIncomplete < 0 ? 0 : firstIncomplete;
    setTaskIndex(nextIndex);
    setSelected(progress.reflections[stage.tasks[nextIndex].id] ?? []);
    setChecked(false);
    setPhase("task");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function toggle(index: number) {
    if (checked) return;
    if (task.kind === "sequence") {
      setSelected(current => current.includes(index) ? current : [...current, index]);
    } else if (task.kind === "multi" || task.kind === "reveal") {
      setSelected(current => current.includes(index) ? current.filter(value => value !== index) : [...current, index]);
    } else {
      setSelected([index]);
    }
  }

  function check() {
    if (!selected.length || checked) return;
    setChecked(true);
    onRecord(stage, task, selected, solved);
  }

  function advance() {
    if (taskIndex < stage.tasks.length - 1) {
      const nextIndex = taskIndex + 1;
      setTaskIndex(nextIndex);
      setSelected(progress.reflections[stage.tasks[nextIndex].id] ?? []);
      setChecked(false);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      onComplete(stage);
      setPhase("conclusion");
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  const taskProgress = phase === "intro" ? 0 : phase === "conclusion" ? 100 : Math.round((taskIndex + (checked ? 1 : 0)) / stage.tasks.length * 100);

  return <section className="stage-page section-wrap">
    <div className="stage-toolbar">
      <button onClick={onClose}>← Маршрут</button>
      <div><span>Этап {stage.number} из {stages.length}</span><div className="progress-line"><i style={{ width: `${taskProgress}%` }} /></div></div>
      <span>{stage.duration}</span>
    </div>

    {phase === "intro" && <>
      <article className="stage-header">
        <div><span className="chapter-pill light">Вопрос {stage.number} из {stages.length}</span><p>Этап {String(stage.number).padStart(2, "0")}</p><h1>{stage.title}</h1></div>
        <div className="stage-big-number">{String(stage.number).padStart(2, "0")}</div>
      </article>
      <article className="stage-intro">
        <span className="kicker">С чего начнём</span><h2>Остановимся и подумаем</h2><p>{stage.intro}</p>
        <blockquote>{stage.opening}</blockquote>
        <button className="primary full" onClick={begin}>{isComplete ? "Пройти этап ещё раз" : firstIncomplete > 0 ? "Продолжить этап" : "Начать размышление"} →</button>
      </article>
    </>}

    {phase === "task" && <TaskView task={task} index={taskIndex} total={stage.tasks.length} selected={selected} checked={checked} solved={solved} onToggle={toggle} onReset={() => setSelected([])} onCheck={check} onAdvance={advance} />}

    {phase === "conclusion" && <article className="conclusion-card">
      <div className="completion-mark">✓</div><span className="kicker">Этап завершён</span><h1>{stage.conclusionTitle}</h1><p>{stage.conclusion}</p>
      <div className="bridge"><span>Следующий вопрос</span><p>{stage.bridge}</p></div>
      <div className="result-actions"><button className="secondary" onClick={onShare}>Поделиться</button><button className="primary" onClick={onNext}>{stage.number === stages.length ? "Посмотреть итог" : "Следующий этап"} →</button></div>
    </article>}
  </section>;
}

function TaskView({ task, index, total, selected, checked, solved, onToggle, onReset, onCheck, onAdvance }: {
  task: JourneyTask;
  index: number;
  total: number;
  selected: number[];
  checked: boolean;
  solved: boolean;
  onToggle: (index: number) => void;
  onReset: () => void;
  onCheck: () => void;
  onAdvance: () => void;
}) {
  const completeReveal = task.kind !== "reveal" || selected.length === task.options.length;
  const canCheck = selected.length > 0 && completeReveal;
  return <>
    <article className="task-card">
      <div className="task-count">Размышление {index + 1} из {total}</div>
      <span className="kicker">{task.eyebrow}</span><h1>{task.prompt}</h1>{task.detail && <p className="task-detail">{task.detail}</p>}

      {task.kind === "sequence" ? <div className="sequence-zone">
        <div className="sequence-result">
          {selected.length ? selected.map((optionIndex, position) => <span key={optionIndex}><b>{position + 1}</b>{task.options[optionIndex]}</span>) : <p>Нажимайте карточки в нужном порядке</p>}
        </div>
        {!checked && <div className="option-pool">{task.options.map((option, optionIndex) => <button key={option} className={selected.includes(optionIndex) ? "chosen" : ""} onClick={() => onToggle(optionIndex)} disabled={selected.includes(optionIndex)}>{option}<span>＋</span></button>)}</div>}
        {!checked && selected.length > 0 && <button className="reset-link" onClick={onReset}>Собрать заново</button>}
      </div> : task.kind === "reveal" ? <div className="reveal-grid">
        {task.options.map((option, optionIndex) => <button key={option} className={selected.includes(optionIndex) ? "revealed" : ""} onClick={() => onToggle(optionIndex)} disabled={checked}>
          <span>{selected.includes(optionIndex) ? "✓" : "+"}</span><p>{selected.includes(optionIndex) ? option : `Открыть часть ${optionIndex + 1}`}</p>
        </button>)}
      </div> : <div className="answer-list">
        {task.options.map((option, optionIndex) => {
          const chosen = selected.includes(optionIndex);
          const correct = task.correct?.includes(optionIndex);
          const className = checked && task.kind !== "reflection" ? correct ? "correct" : chosen ? "wrong" : "" : chosen ? "chosen" : "";
          return <button key={option} className={className} onClick={() => onToggle(optionIndex)} disabled={checked}>
            <span>{task.kind === "multi" ? chosen ? "✓" : "□" : String.fromCharCode(65 + optionIndex)}</span><p>{option}</p>
          </button>;
        })}
      </div>}

      {!checked && <button className="primary full check-button" onClick={onCheck} disabled={!canCheck}>{task.kind === "reflection" ? "Сохранить позицию" : "Проверить ход"} →</button>}
    </article>

    {checked && <article className={`insight-card ${solved ? "solved" : "reconsider"}`}>
      <div className="result-heading"><span>{task.kind === "reflection" ? "◇" : solved ? "✓" : "↺"}</span><div><small>{task.kind === "reflection" ? "Ответ сохранён" : solved ? "Ход выстроен" : "Посмотрим ещё раз"}</small><h2>{task.kind === "reflection" ? "Остановимся на этом ответе" : solved ? "Посмотрим, что из этого следует" : "Обратите внимание на пропущенное звено"}</h2></div></div>
      {task.kind === "sequence" && !solved && <div className="correct-order"><span>Один шаг за другим</span>{task.correct?.map((optionIndex, position) => <p key={optionIndex}><b>{position + 1}</b>{task.options[optionIndex]}</p>)}</div>}
      <p>{task.explanation}</p><div className="takeaway"><span>Главная мысль</span><p>{task.takeaway}</p></div>
      <button className="primary full" onClick={onAdvance}>{index + 1 === total ? "Завершить этап" : "Следующее размышление"} →</button>
    </article>}
  </>;
}

function ProgressView({ progress, onOpen, onShare }: { progress: Progress; onOpen: (id: string) => void; onShare: () => void }) {
  const pct = Math.round(progress.completedStages.length / stages.length * 100);
  const next = stages.find(stage => !progress.completedStages.includes(stage.id));
  return <section className="page section-wrap">
    <div className="page-intro"><span className="kicker">Ваш путь</span><h1>{pct === 100 ? "Путь пройден" : "Карта размышлений"}</h1><p>Здесь важна не скорость, а последовательность: увидеть вопрос, проверить аргумент и понять, как из него следует вывод.</p></div>
    <div className="progress-hero">
      <div className="big-ring" style={{ "--p": `${pct * 3.6}deg` } as React.CSSProperties}><span><b>{pct}%</b>пройдено</span></div>
      <div><span>Завершено</span><h2>{progress.completedStages.length} из {stages.length} этапов</h2><p>{progress.completedTasks.length} из {totalTasks} последовательных шагов</p></div>
    </div>
    <div className="progress-list">{stages.map((stage, index) => {
      const done = progress.completedStages.includes(stage.id);
      const unlocked = index === 0 || progress.completedStages.includes(stages[index - 1].id);
      const completedTasks = stage.tasks.filter(task => progress.completedTasks.includes(task.id)).length;
      return <button key={stage.id} onClick={() => onOpen(stage.id)} disabled={!unlocked}><span className={done ? "done" : ""}>{done ? "✓" : stage.number}</span><div><b>{stage.title}</b><p>{completedTasks}/{stage.tasks.length} размышлений</p><i><em style={{ width: `${completedTasks / stage.tasks.length * 100}%` }} /></i></div><strong>{unlocked ? "→" : "○"}</strong></button>;
    })}</div>
    <div className="progress-actions"><button className="secondary" onClick={onShare}>Поделиться прогрессом</button>{next && <button className="primary" onClick={() => onOpen(next.id)}>Продолжить путь →</button>}</div>
  </section>;
}

function AboutView({ onReset }: { onReset: () => void }) {
  return <section className="page section-wrap">
    <div className="about-hero"><span className="brand-mark large">С</span><div><span>Интерактивный путь</span><h1>В поисках смысла</h1><p>Восемь вопросов о счастье, Создателе,<br />Послании и доверии Богу.</p></div></div>
    <div className="about-grid">
      <article><span className="kicker">Формат</span><h2>Разговор, а не экзамен</h2><p>Здесь не нужно запоминать чужие формулировки. Каждый этап начинается со знакомого наблюдения, допускает возражение и постепенно подводит к следующему вопросу.</p></article>
      <article><span className="kicker">Последовательность</span><h2>Ни одного случайного вопроса</h2><p>Почему нам мало? Почему мы ищем высшее? Что обнаруживает наша слабость? На что указывает мир? Каждый ответ становится началом следующего шага.</p></article>
    </div>
    <div className="book-structure"><span className="kicker">Как устроен путь</span>{["Наблюдение из обычной жизни", "Вопрос к самому себе", "Возможное возражение", "Пример, который можно проверить", "Вывод и новый вопрос"].map(item => <p key={item}>{item}<span>✓</span></p>)}</div>
    <div className="notice"><span>i</span><p>Не торопитесь нажимать варианты. Ценность пути не в скорости и не в количестве совпавших ответов, а в честности перед вопросом.</p></div>
    <div className="privacy"><h2>Прогресс остаётся у вас</h2><p>Ответы сохраняются только в браузере на этом устройстве. Аккаунт и передача личных ответов не требуются.</p><button className="danger-link" onClick={onReset}>Удалить прогресс и начать заново</button></div>
  </section>;
}
