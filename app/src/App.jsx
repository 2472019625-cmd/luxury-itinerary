import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import sampleData from "../data/sample-itinerary.json";
import africaData from "../data/sample-itinerary-africa.json";
import kenyaLuxury8dData from "../data/kenya-luxury-8d.json";
import tanzaniaLuxury10dData from "../data/tanzania-luxury-10d.json";
import { Workspace } from "./Workspace.jsx";
import { createProductionDefaultData, formatTravelerCount, inferOvernightType, isUsableFinalImageSource } from "./lib/itineraryRules.js";
import { AgentPlanner } from "./AgentPlanner.jsx";
import { AgentWorkspace } from "./AgentWorkspace.jsx";
import { normalizeLegacyNotesForDisplay } from './lib/notesSchema.js';
import { transportConfigurationLabels, transportProductName, transportUsageLabel } from './lib/transportPresentation.js';
import { dayVisualCards } from './lib/dayVisualCards.js';
import { coverLayout } from './lib/coverLayout.js';
import { buildCustomerTravelEntityData, sameTravelEntityName } from './lib/travelEntityDisplay.js';
import { normalizeHighlightsForDisplay } from './lib/highlightDisplay.js';
import { deriveFeaturedCardLayout } from './lib/featuredCardLayout.js';
const VisualBindingsContext = React.createContext(undefined);

const ICON = "/assets/icons/";
const SLOGAN = "高品质度假管家，懂度假，更懂你";

function Icon({ name, size = 48, tone = "gold" }) {
  return <span className={`icon icon-${tone}`} style={{ width: size, height: size, WebkitMaskImage: `url(${ICON}${name}.svg)`, maskImage: `url(${ICON}${name}.svg)` }} aria-hidden="true" />;
}

function MissingImageState({ label = "图片待补充", compact = false, className = "", ...props }) {
  return <div className={`missing-image-state${compact ? " missing-image-state-compact" : ""} ${className}`.trim()} role="img" aria-label={label} {...props}><Icon name="itinerary" size={compact ? 34 : 54} /><span>{label}</span></div>;
}

function SafeImage({ src, alt, fallbackLabel, ...props }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!isUsableFinalImageSource(src) || failed) return <MissingImageState label={fallbackLabel || `${alt || "图片"}暂缺`} {...props} />;
  return <img {...props} src={src} alt={alt} onError={() => setFailed(true)} />;
}

function AutoFitTitle({ children }) {
  const ref = useRef(null);
  const [style, setStyle] = useState({ fontSize: "112px", whiteSpace: "nowrap" });
  useLayoutEffect(() => {
    const fit = () => {
      const node = ref.current;
      if (!node) return;
      let size = 112;
      node.style.fontSize = `${size}px`;
      node.style.whiteSpace = "nowrap";
      while (node.scrollWidth > node.clientWidth && size > 64) {
        size -= 2;
        node.style.fontSize = `${size}px`;
      }
      const wraps = node.scrollWidth > node.clientWidth;
      setStyle({ fontSize: `${size}px`, whiteSpace: wraps ? "normal" : "nowrap" });
    };
    fit();
    document.fonts?.ready?.then(fit);
    const observer = new ResizeObserver(fit);
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [children]);
  return <h1 ref={ref} style={style}>{children}</h1>;
}

function formatDate(date) {
  if (!date) return "日期待定";
  const value = new Date(`${date}T00:00:00`);
  if (Number.isNaN(value.getTime())) return String(date);
  return `${value.getFullYear()}.${String(value.getMonth() + 1).padStart(2, "0")}.${String(value.getDate()).padStart(2, "0")}`;
}

function chineseDay(index) {
  const values = ["第一天", "第二天", "第三天", "第四天", "第五天", "第六天", "第七天", "第八天", "第九天", "第十天", "第十一天", "第十二天", "第十三天", "第十四天", "第十五天"];
  return values[index] || `第${index + 1}天`;
}

function SectionTitle({ en, zh }) {
  return <header className="section-title"><span className="section-title-en">{en}</span><h2>{zh}</h2></header>;
}

function InfoPill({ icon, label, value }) {
  if (!value) return null;
  return <div className="info-pill"><span className="meta-label">{label}</span><div className="info-pill-card"><Icon name={icon} size={72} /><strong>{value}</strong></div></div>;
}

function SloganLockup() {
  return <div className="slogan-lockup"><span>{SLOGAN}</span></div>;
}

function CoverVisual({ src, focus, alt }) {
  const [layout, setLayout] = useState(() => coverLayout());
  return <div className={`cover-visual${layout.aspectRatio ? " cover-visual-adaptive" : ""}`}>
    <SloganLockup />
    <div className={`hero-frame hero-frame-${layout.displayMode}`} data-display-mode={layout.displayMode} style={layout.aspectRatio ? { aspectRatio: layout.aspectRatio, height: "auto", boxSizing: "content-box" } : undefined}>
      <SafeImage src={src} alt={alt} fallbackLabel="行程图片待补充" data-edit-path="cover" data-edit-image="0" onLoad={(event) => setLayout(coverLayout(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight))} style={{ objectPosition: focus || "50% 50%" }} />
      <div className="hero-overlay" />
    </div>
  </div>;
}

function Cover({ data }) {
  const defaultDesigner = {
    name: "定制师名字",
    avatar: "/assets/placeholders/avatar.png",
    role: "资深定制师",
    bio: "专属定制师将与您1V1沟通，从路线节奏、酒店房型到在地体验持续跟进，\n让你的旅行 有品质 也有范儿",
    phone: "",
    wechat: "",
  };
  const hasDesigner = Boolean(data.designer?.name || data.designer?.avatar);
  const designer = { ...defaultDesigner, ...(data.designer || {}) };
  const contacts = [
    { label: "定制师电话", value: String(designer.phone || "").trim(), icon: "contact" },
    { label: "工作微信", value: String(designer.wechat || "").trim(), icon: "wechat" },
  ].filter((item) => item.value);
  const metrics = [["从业时间", designer.experience], ["成交单量", designer.orders], ["客户好评", designer.praise]].filter(([, value]) => value);
  return (
    <section className="cover" data-edit-path="cover">
      <img className="brand-logo brand-logo-cover" src="/assets/logos/logo-gold.png" alt="奢游国际 Luxury Travel" />
      <div className="cover-copy"><span className="eyebrow">PRIVATE JOURNEY · {data.destination}</span><AutoFitTitle>{data.title}</AutoFitTitle><p>{data.subtitle}</p></div>
      <CoverVisual key={data.heroImage || "missing-cover"} src={data.heroImage} focus={data.heroFocus} alt={data.destination || "封面主图"} />
      <div className={`designer-card${hasDesigner ? "" : " designer-card-placeholder"}${metrics.length ? " designer-card-has-metrics" : " designer-card-no-metrics"}`}>
        <img src={designer.avatar} alt={designer.name} />
        <div className="designer-heading"><strong>{designer.name}</strong><span>{designer.role || "资深定制师"}</span>{contacts.length > 0 && <dl className={`designer-contact-row designer-contact-count-${contacts.length}`}>{contacts.map((item) => <div className="designer-contact-item" key={item.label}><dt><Icon name={item.icon} size={36} /><span>{item.label}</span></dt><dd>{item.value}</dd></div>)}</dl>}<p>{String(designer.bio || "").split("\n").map((line, index) => <span className="designer-bio-line" key={`${line}-${index}`}>{line}</span>)}</p></div>
        {metrics.length > 0 && <div className="designer-metrics">{metrics.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>}
      </div>
      <div className="cover-meta">
        <InfoPill icon="people" label="出行人数" value={formatTravelerCount(data)} />
        <InfoPill icon="itinerary" label="出行天数" value={`${data.dayCount || data.days.length}天${Math.max(0, (data.dayCount || data.days.length) - 1)}晚`} />
        <InfoPill icon="departure" label="出发日期" value={formatDate(data.startDate)} />
        <InfoPill icon="return" label="返程日期" value={formatDate(data.endDate)} />
      </div>
    </section>
  );
}

function DiningOverview({ items = [], policy, title = "特色餐饮", introTitle, introCopy }) {
  if (!items.length) return null;
  const isOdd = items.length % 2 === 1;
  const { entries, hasFeatured } = deriveFeaturedCardLayout(items, "dining");
  const resolvedIntroTitle = introTitle || "旅途中的风味时刻";
  const resolvedIntroCopy = introCopy || "精选行程中最具代表性的餐饮与品饮体验，让不同风味、用餐方式与在地场景，共同构成旅途的味觉记忆。";
  return <section className="journey-feature-section dining-section" data-edit-path="dining"><SectionTitle en="CULINARY JOURNEY" zh={title} /><div className="feature-intro"><span>{resolvedIntroTitle}</span><p>{resolvedIntroCopy}</p></div><div className={`dining-grid${isOdd ? " dining-grid-odd" : ""}${hasFeatured ? " dining-grid-featured" : ""}`}>{entries.map(({ item, originalIndex: itemIndex, isFeatured: isWide }) => {
    const images = (item.images?.length ? item.images : item.image ? [item.image] : []).slice(0, 2);
    return <article className={`dining-card${isWide ? " dining-card-wide" : ""}`} key={item.id || item.title} data-edit-path={`dining.${itemIndex}`}>
    {images.length > 0 ? <div className={`dining-image dining-image-count-${images.length}`}>{images.map((image, imageIndex) => <SafeImage key={`${item.id || item.title}-${imageIndex}`} src={image.src || image} alt={image.label || `${item.title}${images.length > 1 ? `体验${imageIndex + 1}` : ""}`} data-edit-path={`dining.${itemIndex}`} data-edit-image={imageIndex} style={{ objectPosition: image.focus || "50% 50%", objectFit: image.fit }} />)}</div> : <MissingImageState label="餐饮图片待补充" compact className="card-missing-image" data-edit-path={`dining.${itemIndex}`} data-edit-image="0" />}
    <div className="dining-copy"><small>{item.location}</small><h3>{item.title}</h3>{item.officialName && <p className="dining-official-name">{item.officialName}</p>}<p>{item.editorialCopy}</p></div>
  </article>;
  })}</div>{policy && <p className="feature-footnote">{policy}</p>}</section>;
}

function Highlights({ items = [], title = "产品亮点" }) {
  const highlights = normalizeHighlightsForDisplay(items);
  if (!highlights.length) return null;
  return <section className="content-section card-panel highlights" data-edit-path="highlights"><div className="panel-heading"><h2>{title}</h2><span>PRODUCT<br />HIGHLIGHTS</span></div><div className="highlight-list">{highlights.map(({ title: itemTitle, description }, index) => {
    return <div className="highlight-item" key={`${itemTitle}-${index}`} data-edit-path={`highlights.${index}`}><span className="crown-disc"><Icon name="crown" size={52} tone="light" /></span><div className="highlight-copy"><h3>{itemTitle}</h3>{description && <p>{description}</p>}</div></div>;
  })}</div></section>;
}

const MEAL_LABELS = { breakfast: "早", lunch: "午", dinner: "晚" };
const MEAL_NEGATIVE_PATTERN = /自理|不含|未含|无餐|不安排|自费/;
const MEAL_PENDING_PATTERN = /待确认|最终确认|确认安排|以.*为准|视.*安排|按行程所列/;

function summarizeMeals(day) {
  const plan = day.mealPlan;
  if (plan && typeof plan === "object" && !Array.isArray(plan)) {
    const included = [];
    const excluded = [];
    const pending = [];
    Object.entries(MEAL_LABELS).forEach(([key, label]) => {
      const value = String(plan[key] || "").trim();
      if (!value) return;
      if (MEAL_NEGATIVE_PATTERN.test(value)) excluded.push(label);
      else if (MEAL_PENDING_PATTERN.test(value)) pending.push(label);
      else included.push(label);
    });
    const parts = [];
    if (included.length) parts.push(`含餐｜${included.join(" · ")}`);
    if (excluded.length) parts.push(`${excluded.join("、")}餐自理`);
    if (pending.length) parts.push(`${pending.join("、")}餐待确认`);
    if (parts.length) return parts.join("；");
  }

  const text = String(day.meals || plan || "").trim();
  if (!text) return "餐食｜待确认";
  if (MEAL_PENDING_PATTERN.test(text)) return "餐食｜待确认";
  if (/全餐|三餐/.test(text)) return "含餐｜早 · 午 · 晚";
  const segments = text.split(/[\/、；;]/).map((item) => item.trim()).filter(Boolean);
  const included = [
    [/早餐|(^|\s)早(\s|$)/, "早"],
    [/午餐|中餐|(^|\s)午(\s|$)/, "午"],
    [/晚餐|(^|\s)晚(\s|$)/, "晚"],
  ].filter(([pattern]) => segments.some((segment) => pattern.test(segment) && !MEAL_NEGATIVE_PATTERN.test(segment))).map(([, label]) => label);
  if (!included.length && MEAL_NEGATIVE_PATTERN.test(text)) return "未含餐";
  return included.length ? `含餐｜${included.join(" · ")}` : "餐食｜待确认";
}

function Overview({ days, title = "行程总览" }) {
  return <section className="content-section card-panel overview" data-edit-path="overview"><div className="panel-heading"><h2>{title}</h2><span>ITINERARY<br />OVERVIEW</span></div><div className="overview-list">{days.map((day, index) => {
    const routeNodes = day.routeNodes?.length ? day.routeNodes : [day.city];
    const route = routeNodes.join(" → ");
    return <article className="overview-day-card" key={`${day.date}-${day.city}-${index}`} data-edit-path={`overview.${index}`}>
      <div className="overview-day-index"><span>DAY</span><strong>{String(index + 1).padStart(2, "0")}</strong></div>
      <div className="overview-day-main"><h3>{routeNodes.map((node, nodeIndex) => <span className="overview-route-step" key={`${node}-${nodeIndex}`}>{nodeIndex > 0 && <span className="overview-route-arrow" aria-hidden="true">→</span>}<span className="overview-route-node">{node}</span></span>)}</h3><p>{day.theme || route}</p><div className="overview-day-meta"><span className="overview-meal-summary"><Icon name="meal" size={28} />{summarizeMeals(day)}</span>{day.overviewNote && <span><Icon name="vehicle" size={28} />{day.overviewNote}</span>}</div></div>
    </article>;
  })}</div></section>;
}

function HotelsOverview({ hotels = [], policy, title = "臻选酒店", introTitle = "住进风景深处，也住进旅程的黄金位置", introCopy = "每一处下榻都服务于路线节奏：或更接近游猎现场，或以完整度假体验承接长途移动后的松弛时刻。" }) {
  if (!hotels.length) return null;
  const displayTitle = !title || title === "臻选下榻" ? "臻选酒店" : title;
  const isOdd = hotels.length % 2 === 1;
  const { entries, hasFeatured } = deriveFeaturedCardLayout(hotels, "hotel");
  return <section className="journey-feature-section hotels-section" data-edit-path="hotels"><SectionTitle en="SIGNATURE STAYS" zh={displayTitle} /><div className="feature-intro"><span>{introTitle}</span><p>{introCopy}</p></div><div className={`hotel-grid${isOdd ? " hotel-grid-odd" : ""}${hasFeatured ? " hotel-grid-featured" : ""}`}>{entries.map(({ item: hotel, originalIndex: hotelIndex, isFeatured }) => {
    const factRows = Array.isArray(hotel.factRows) ? hotel.factRows.filter((row) => String(row?.text || "").trim()) : [];
    return <article className={`hotel-card${isFeatured ? " hotel-card-wide" : ""}${hotel.images?.[0] ? "" : " hotel-card-no-image"}`} key={hotel.id || hotel.officialName} data-edit-path={`hotels.${hotelIndex}`}>
    {hotel.images?.[0] ? <div className="hotel-image"><SafeImage src={hotel.images[0].src || hotel.images[0]} alt={hotel.shortName || hotel.officialName} fallbackLabel="酒店图片待补充" data-edit-path={`hotels.${hotelIndex}`} data-edit-image="0" style={{ objectPosition: hotel.images[0].focus || "50% 50%" }} /></div> : <MissingImageState label="酒店图片待补充" compact className="card-missing-image" data-edit-path={`hotels.${hotelIndex}`} data-edit-image="0" />}
    <div className="hotel-copy"><div className="hotel-kicker"><span>{hotel.region}</span><em>{hotel.nights}晚</em></div><h3>{hotel.shortName || hotel.officialName}</h3>{hotel.shortName && hotel.officialName && !sameTravelEntityName(hotel.shortName, hotel.officialName) && <p className="hotel-official-name">{hotel.officialName}</p>}
      {factRows.length > 0 ? <ul className="hotel-fact-rows">{factRows.map((row) => <li key={row.key || row.label}><span className="hotel-fact-label">{row.label}</span><span className="hotel-fact-text">{row.text}</span></li>)}</ul> : <>
        {hotel.editorialCopy && <p className="hotel-editorial">{hotel.editorialCopy}</p>}
        {hotel.proofPoints?.length > 0 && <div className="hotel-proof-points">{hotel.proofPoints.map((point) => <span key={point}>{point}</span>)}</div>}
      </>}
    </div>
  </article>;
  })}</div>{policy && <p className="feature-footnote">{policy}</p>}</section>;
}

function TransportOverview({ items = [], disclaimer, title = "全程交通", introTitle = "移动不是赶路，而是旅程体验的一部分", introCopy = "城市接送、专属游猎、草原飞行与海上衔接各司其职，让跨区域移动保持私密、舒适与从容。" }) {
  if (!items.length) return null;
  const isOdd = items.length % 2 === 1;
  const { entries, hasFeatured } = deriveFeaturedCardLayout(items, "transport");
  return <section className="journey-feature-section transport-section" data-edit-path="transport"><SectionTitle en="TRAVEL IN COMFORT" zh={title} /><div className="feature-intro"><span>{introTitle}</span><p>{introCopy}</p></div><div className={`transport-grid${isOdd ? " transport-grid-odd" : ""}${hasFeatured ? " transport-grid-featured" : ""}`}>{entries.map(({ item, originalIndex: itemIndex, isFeatured: isWide }) => {
    const configurationLabels = transportConfigurationLabels(item);
    return <article className={`transport-card${isWide ? " transport-card-wide" : ""}`} key={item.id || item.category} data-edit-path={`transport.${itemIndex}`}>
    {item.images?.length > 0 ? <div className={`transport-image transport-image-count-${Math.min(item.images.length, 2)}`}>{item.images.slice(0, 2).map((image, imageIndex) => <SafeImage key={`${item.id}-${imageIndex}`} src={image.src || image} alt={`${item.category}${imageIndex ? "内部空间" : "出行场景"}`} data-edit-path={`transport.${itemIndex}`} data-edit-image={imageIndex} style={{ objectPosition: image.focus || "50% 50%", objectFit: image.fit }} />)}</div> : <MissingImageState label="交通图片待补充" compact className="card-missing-image" data-edit-path={`transport.${itemIndex}`} data-edit-image="0" />}
    <div className="transport-copy"><div className="transport-heading"><span className="transport-icon"><Icon name="vehicle" size={44} tone="light" /></span><div><small>{transportUsageLabel(item)}</small><h3>{transportProductName(item)}</h3></div></div>
      {configurationLabels.length > 0 && <div className="transport-specs">{configurationLabels.map((label) => <span key={label}>{label}</span>)}</div>}
      {item.editorialCopy && <p className="transport-editorial">{item.editorialCopy}</p>}
      {item.features?.length > 0 && <ul>{item.features.map((feature) => <li key={feature}>{feature}</li>)}</ul>}
    </div>
  </article>;
  })}</div>{disclaimer && <p className="feature-footnote">{disclaimer}</p>}</section>;
}

function ServiceTags({ day }) {
  const tags = [["vehicle", day.vehicle], ["driver", day.driver], ["guide", day.guide]].filter(([, value]) => value);
  if (!tags.length) return null;
  return <div className="service-tags">{tags.map(([icon, value]) => <span key={`${icon}-${value}`}><Icon name={icon} size={34} tone="light" />{value}</span>)}</div>;
}

function RoutePreview({ day }) {
  const route = day.routeNodes?.length ? day.routeNodes : String(day.city || "").split(/[—–-]/).filter(Boolean);
  if (!route.length) return null;
  return <div className="route-preview"><span className="fact-icon"><Icon name="itinerary" size={64} tone="light" /></span><div><small>当日路线</small><div className="route-nodes">{route.map((node, index) => <span key={`${node}-${index}`}><strong>{node}</strong>{index < route.length - 1 && <i>→</i>}</span>)}</div></div></div>;
}

function DayDescription({ day }) {
  return <div className="day-fact fact-description"><span className="fact-icon"><Icon name="city" size={64} tone="light" /></span><div><span>当日行程</span><p>{day.description}</p></div></div>;
}

function DayFacts({ day }) {
  const meal = day.mealPlan;
  const rhythm = [day.vehicle, day.estimatedTravelTime || day.movementPaceDescriptor, day.activityLevel && `活动强度：${day.activityLevel}`, day.restStops].filter(Boolean);
  return <div className="day-facts">
    <RoutePreview day={day} />
    <OvernightFact day={day} />
    {(meal || day.meals) && <div className="day-fact"><span className="fact-icon"><Icon name="meal" size={64} tone="light" /></span><div><span>当日用餐</span>{meal ? <div className="meal-grid">{[["早餐", meal.breakfast], ["午餐", meal.lunch], ["晚餐", meal.dinner]].filter(([, value]) => value).map(([label, value]) => <p key={label}><small>{label}</small><strong>{value}</strong></p>)}</div> : <strong>{day.meals}</strong>}{meal?.special && <div className="special-meal"><em>特色餐饮</em><b>{meal.special}</b></div>}</div></div>}
    {rhythm.length > 0 && <div className="day-fact day-rhythm"><span className="fact-icon"><Icon name="vehicle" size={64} tone="light" /></span><div><span>当日节奏</span><div className="rhythm-chips">{rhythm.map((item) => <b key={item}>{item}</b>)}</div></div></div>}
  </div>;
}

function OvernightFact({ day }) {
  const type = inferOvernightType(day);
  if (type === "none") return <div className="day-fact day-overnight-none"><span className="fact-icon"><Icon name="return" size={64} tone="light" /></span><div><span>当晚安排</span><strong>无住宿 · 行程结束</strong></div></div>;
  if (type === "inflight") return <div className="day-fact day-overnight-inflight"><span className="fact-icon"><Icon name="departure" size={64} tone="light" /></span><div><span>当晚安排</span><strong>{day.overnightLabel || "返程航班"}</strong></div></div>;
  if (!day.hotel) return null;
  return <div className="day-fact"><span className="fact-icon"><Icon name="hotel" size={64} tone="light" /></span><div><span>当晚入住</span><strong>{day.hotelShortName || day.hotel}</strong></div></div>;
}

function SpotCard({ spot, dayIndex, spotIndex, spotId, slotId, imageIndexBase = 0 }) {
  // DAY cards do not show status badges; keep the underlying business facts intact.
  const images = (spot.images?.length ? spot.images : spot.image ? [{ src: spot.image, focus: spot.focus, fit: spot.fit }] : []).filter((image) => typeof image === "string" ? Boolean(image) : Boolean(image?.src)).slice(0, 2);
  const identity = { "data-edit-path": `days.${dayIndex}.spots.${spotIndex}`, "data-edit-spot-id": spotId || undefined, "data-edit-slot-id": slotId || undefined };
  return <article className="spot-card" {...identity}>{images.length > 0 ? <div className={`spot-image spot-image-count-${images.length}`}>{images.map((image, imageIndex) => <SafeImage key={`${spot.name}-${imageIndex}`} src={image.src || image} alt={image.label || `${spot.name}${images.length > 1 ? `体验${imageIndex + 1}` : ""}`} {...identity} data-edit-image={imageIndexBase + imageIndex} style={{ objectPosition: image.focus || "50% 50%", objectFit: image.fit }} />)}</div> : <MissingImageState label="体验图片待补充" compact className="card-missing-image" {...identity} data-edit-image={imageIndexBase} />}<div className="spot-copy"><h4>{spot.name}</h4><p>{spot.experience || spot.description}</p>{spot.reminder && <small>{spot.reminder}</small>}</div></article>;
}

function SpotGallery({ spots = [], dayIndex }) {
  const bindings = React.useContext(VisualBindingsContext);
  const cards = dayVisualCards({ spots }, dayIndex, bindings);
  if (!cards.length) return null;
  const groups = [];
  for (let index = 0; index < cards.length; index += 4) groups.push(cards.slice(index, index + 4));
  return <div className="spot-galleries">{groups.map((group, groupIndex) => <div className={`spot-gallery spot-count-${group.length}`} key={groupIndex}>{group.map(({ spot, spotId, spotIndex, imageIndex, slotId }) => <SpotCard key={slotId || spotId || spotIndex} spot={spot} dayIndex={dayIndex} spotIndex={spotIndex} spotId={spotId} slotId={slotId} imageIndexBase={imageIndex} />)}</div>)}</div>;
}

function DaySection({ day, index }) {
  return <section className="day-section" data-edit-path={`days.${index}`}><header className="day-header"><div className="day-date"><strong>DAY {index + 1}</strong><span>/</span><time>{formatDate(day.date)}</time></div>{day.theme && <h2>{day.theme}</h2>}<ServiceTags day={day} /></header><div className="day-body"><DayDescription day={day} /><SpotGallery spots={day.spots} dayIndex={index} /><DayFacts day={day} /></div></section>;
}

function ListCard({ icon, title, items, tone = "gold" }) {
  if (!items?.length) return null;
  return <section className={`list-card list-card-${tone}`}><header><h3>{title}</h3><Icon name={icon} size={54} tone={tone === "warning" ? "warning" : "gold"} /></header><ul>{items.map((item) => {
    const match = item.match(/^([^：:｜|]{1,14})[：:｜|]\s*(.+)$/);
    return <li key={item}>{match ? <><strong className="list-keyword">{match[1]}：</strong><span>{match[2]}</span></> : item}</li>;
  })}</ul></section>;
}

function Expenses({ data }) {
  if (data.showExpenseSection === false) return null;
  const show = data.totalPrice || data.included?.length || data.excluded?.length || data.cancellation?.length;
  if (!show) return null;
  return <section className="expense-section" data-edit-path="expenses"><SectionTitle en="EXPENSE" zh="费用说明" />{data.totalPrice != null && <div className="total-price"><strong>{Number(data.totalPrice).toLocaleString("zh-CN")}</strong><em>{data.priceUnit}</em></div>}{data.priceNotes?.length > 0 && <div className="price-notes"><h3>报价说明</h3>{data.priceNotes.map((note) => <p key={note}>{note}</p>)}</div>}<div className="expense-grid"><ListCard icon="included" title="费用包含" items={data.includedCustomer?.length ? data.includedCustomer : data.included} /><ListCard icon="excluded" title="费用不含" items={data.excludedCustomer?.length ? data.excludedCustomer : data.excluded} /><ListCard icon="cancellation" title="退改政策" items={data.cancellationCustomer?.length ? data.cancellationCustomer : data.cancellation} /></div></section>;
}

function BookingFlow() {
  const steps = [
    ["说出您的向往", ["告知出行时间、目的地与人数，", "任何天马行空的想法，我们都认真聆听。"], "contact"],
    ["专属定制师就位", ["专属旅行顾问24小时内致电或添加微信，", "第一时间响应您的期待。"], "guide"],
    ["查收定制方案", ["您将收到一份涵盖行程动线、", "甄选酒店与特色体验的完整方案。"], "itinerary"],
    ["随心调整至臻", ["路线、房型、餐食均可按您的偏好调整，", "直至每一处细节都契合心意。"], "included"],
    ["锁定稀缺资源", ["确认方案并完成支付签约，", "即刻为您抢订限量席位及特殊体验资源。"], "payment"],
    ["静候非凡之旅", ["专属服务群全程护航，", "出行琐事尽托付于我们，您只需随心而动。"], "calendar"],
  ];
  return <section className="booking-section" data-edit-path="booking"><SectionTitle en="BOOKING" zh="预订流程" /><div className="booking-flow">{steps.map(([title, copyLines, icon], index) => <div className={`booking-step booking-step-${index % 2 ? "right" : "left"}`} key={title}><div className="booking-copy"><h3>{title}<Icon name={icon} size={46} tone="warning" /></h3><p>{copyLines.map((line) => <span key={line}>{line}</span>)}</p></div><strong>{String(index + 1).padStart(2, "0")}</strong></div>)}</div></section>;
}

function SecurityAndPayment({ payment, showSecuritySection = true, showPaymentSection = true }) {
  if (!showSecuritySection) return null;

  const accountTitle = payment?.accountTitle || "奢游国际指定收款账户";
  const companyName = payment?.companyName || payment?.company;
  const accountLines = [
    payment?.alipayAccount && `对公支付宝账号：${payment.alipayAccount}`,
    payment?.accountName && `账户名称：${payment.accountName}`,
    payment?.bankAccount && `银行账号：${payment.bankAccount}`,
    payment?.bankName && `开户行：${payment.bankName}`,
  ].filter(Boolean);
  const legacyFallback = [payment?.account, payment?.bank].filter(Boolean);
  const displayLines = accountLines.length ? accountLines : legacyFallback.length ? legacyFallback : ["以正式合同所附账户为准"];

  return <section className="security-section">
    <div className="security-title-area">
      <SectionTitle en="SECURITY" zh="资金安全提醒" />
      <div className="security-banner"><p>我司订单统一对公结算，无任何个人收款渠道，请谨防受骗。</p></div>
    </div>
    {showPaymentSection && payment && <div className="payment-visual">
      <div className="payment-heading">
        <span>{accountTitle}</span>
        {companyName && <h3>{companyName}</h3>}
      </div>
      {payment.qrImage && <div className="payment-qr-group">
        <img className="payment-qr" src={payment.qrImage} alt="支付宝收款二维码" />
        <strong>支付宝收款</strong>
      </div>}
      <div className="payment-account-lines">{displayLines.map((line) => <p key={line}>{line}</p>)}</div>
      {payment.notice && <p className="payment-notice">{payment.notice}</p>}
    </div>}
  </section>;
}

function Notes({ notes, title = "注意事项", intro = "下面这些小提醒，会由定制师在行前为您逐项复核，让旅程更从容。" }) {
  if (!notes?.length) return null;
  const groups = normalizeLegacyNotesForDisplay(notes);
  return <section className="notes-section notes-section-compact" data-edit-path="notes"><SectionTitle en="CAUTIONS" zh={title} /><div className="notes-panel">
    <p className="notes-lead">{intro}</p>
    <div className={`notes-compact-grid notes-count-${groups.length}`}>{groups.map((group, index) => <article className={`notes-compact-item notes-compact-${group.tone || "gold"}`} key={group.title} data-edit-path={`notes.${index}`}>
      <header><Icon name={group.icon || "warning"} size={34} tone={group.tone === "warning" ? "warning" : "gold"} /><h3>{group.title}</h3></header>
      <ul>{group.items.map((item, itemIndex) => <li key={`${group.title}-${itemIndex}`}>{item}</li>)}</ul>
    </article>)}</div>
  </div></section>;
}

function BrandSourceCrop({ variant, alt }) {
  return <div className={`brand-source-crop brand-source-crop-${variant}`}><img src="/assets/brand/about-contact-source-v2.jpg" alt={alt} /></div>;
}

function BrandContactArtwork() {
  return <div className="brand-source-crop brand-source-crop-contact-wave"><img src="/assets/brand/about-contact-source-v2.jpg" alt="奢游国际社交媒体、联系账号与品牌波浪背景" /><span className="brand-contact-cta-mask" aria-hidden="true" /></div>;
}

function Footer() {
  return <footer className="brand-footer-fixed" data-edit-path="footer">
    <section className="brand-footer-section brand-about-section"><SectionTitle en="ABOUT US" zh="关于我们" /><BrandSourceCrop variant="about" alt="奢游国际品牌介绍、合作资质与品牌荣誉" /></section>
    <section className="brand-footer-section brand-contact-section"><SectionTitle en="FOLLOW US" zh="联系我们" /><BrandContactArtwork /></section>
  </footer>;
}

function buildScenario(data, scenario) {
  if (!scenario || scenario === "standard") return data;
  if (scenario === "short") return { ...data, dayCount: 3, days: data.days.slice(0, 3), endDate: data.days[2].date };
  if (scenario === "no-images") return { ...data, days: data.days.map((day) => ({ ...day, spots: [] })) };
  if (scenario === "long-copy") return { ...data, days: data.days.map((day) => ({ ...day, description: `${day.description}${day.description}${day.description}` })) };
  if (scenario === "three-images") { const source = data.days.flatMap((day) => day.spots || []).slice(0, 3); return { ...data, days: data.days.map((day, index) => index === 0 ? { ...day, spots: source } : day) }; }
  if (scenario === "four-images") { const source = data.days.find((day) => day.spots?.length === 4)?.spots || data.days.flatMap((day) => day.spots || []).slice(0, 4); return { ...data, days: data.days.map((day) => ({ ...day, spots: source })) }; }
  if (scenario === "missing-services") return { ...data, days: data.days.map((day, index) => index % 2 ? { ...day, hotel: null, driver: null, guide: null } : day) };
  if (scenario === "no-payment") return { ...data, showPaymentSection: false };
  if (scenario === "no-security") return { ...data, showSecuritySection: false };
  if (scenario === "payment-no-qr") return { ...data, payment: { accountTitle: data.payment?.accountTitle, companyName: data.payment?.companyName, notice: data.payment?.notice } };
  if (scenario === "designer-contact") return { ...data, designer: { ...(data.designer || {}), name: "Sunny", role: "资深定制师", phone: "138 0000 0000", wechat: "LuxuryTravel_Sunny" } };
  if (scenario === "designer-phone-only") return { ...data, designer: { ...(data.designer || {}), name: "Sunny", role: "资深定制师", phone: "138 0000 0000", wechat: "" } };
  if (scenario === "designer-wechat-only") return { ...data, designer: { ...(data.designer || {}), name: "Sunny", role: "资深定制师", phone: "", wechat: "LuxuryTravel_Sunny" } };
  if (scenario === "designer-wechat-long") return { ...data, designer: { ...(data.designer || {}), name: "Sunny", role: "资深定制师", phone: "", wechat: "LuxuryTravel_Enterprise_Service_Sunny_2026" } };
  if (scenario === "composite-images") {
    const diningSources = data.diningExperiences?.slice(0, 2).map((item, index) => ({ ...(item.image || item.images?.[0]), label: `餐饮子体验${index + 1}` })).filter((item) => item?.src);
    const spotSources = data.days.flatMap((day) => day.spots || []).slice(0, 2).map((spot, index) => ({ src: spot.image || spot.images?.[0]?.src, label: `行程子体验${index + 1}`, focus: spot.focus, fit: spot.fit })).filter((item) => item.src);
    return {
      ...data,
      diningExperiences: data.diningExperiences?.map((item, index) => index === 0 && diningSources.length === 2 ? { ...item, image: undefined, images: diningSources } : item),
      days: data.days.map((day, dayIndex) => ({ ...day, spots: day.spots?.map((spot, spotIndex) => dayIndex === 0 && spotIndex === 0 && spotSources.length === 2 ? { ...spot, image: undefined, images: spotSources } : spot) })),
    };
  }
  if (scenario === "long") {
    const baseTime = data.startDate ? new Date(`${data.startDate}T00:00:00`).getTime() : null;
    const days = Array.from({ length: 15 }, (_, index) => ({ ...data.days[index % data.days.length], date: baseTime == null ? null : new Date(baseTime + index * 86400000).toISOString().slice(0, 10), city: `${data.days[index % data.days.length].city}${index >= data.days.length ? " · 延伸行程" : ""}` }));
    return { ...data, dayCount: 15, days, endDate: days[14].date };
  }
  return data;
}

export function Itinerary({ data, scale = 1 }) {
  return <VisualBindingsContext.Provider value={data.simpleImageSlotBindings}><ItineraryContent data={data} scale={scale} /></VisualBindingsContext.Provider>;
}

function ItineraryContent({ data, scale = 1 }) {
  return <div className="export-frame" style={{ width: `${2000 * scale}px` }}><main id="itinerary" className="itinerary-canvas" style={{ transform: scale === 1 ? undefined : `scale(${scale})` }}><Cover data={data} /><div className="page-content intro-content"><Highlights items={data.highlights} title={data.highlightsSectionTitle} />{data.showOverviewSection !== false && <Overview days={data.days} title={data.overviewSectionTitle} />}<HotelsOverview hotels={data.hotels} policy={data.hotelReplacementPolicy} title={data.hotelSectionTitle} introTitle={data.hotelIntroTitle} introCopy={data.hotelIntroCopy} /><DiningOverview items={data.diningExperiences} policy={data.diningPolicy} title={data.diningSectionTitle} introTitle={data.diningIntroTitle} introCopy={data.diningIntroCopy} /><TransportOverview items={data.transportSummary} disclaimer={data.transportDisclaimer} title={data.transportSectionTitle} introTitle={data.transportIntroTitle} introCopy={data.transportIntroCopy} /><SectionTitle en="HOLIDAY MEET" zh="行程细节" /></div><div className="days-wrap">{data.days.map((day, index) => <DaySection day={day} index={index} key={`${day.date}-${index}`} />)}</div><div className="page-content closing-content"><Expenses data={data} />{data.showBookingSection !== false && <BookingFlow />}<SecurityAndPayment payment={data.payment} showSecuritySection={data.showSecuritySection !== false} showPaymentSection={data.showPaymentSection !== false} /><Notes notes={data.notes} title={data.notesSectionTitle} intro={data.notesIntro} /></div><Footer /></main></div>;
}

function CoverGradientProof({ data }) {
  return <section className="cover cover-gradient-proof"><img className="brand-logo brand-logo-cover" src="/assets/logos/logo-gold.png" alt="奢游国际 Luxury Travel" /><div className="cover-copy"><span className="eyebrow">PRIVATE JOURNEY · {data.destination}</span><h1>{data.title}</h1><p>{data.subtitle}</p></div></section>;
}

function StyleProofA({ data }) {
  const index = 0;
  const day = data.days[index];
  return <main id="style-proof-a" className="style-proof-a">
    <Cover data={data} />
    <div className="page-content intro-content"><Highlights items={data.highlights} /><Overview days={data.days} /><SectionTitle en="HOLIDAY MEET" zh="行程细节" /></div>
    <header className="day-header"><div className="day-date"><strong>DAY {index + 1}</strong><span>/</span><time>{formatDate(day.date)}</time></div><ServiceTags day={day} /></header>
  </main>;
}

export function App() {
  if (window.location.pathname.startsWith("/agent-diagnostics") || window.location.pathname.startsWith("/agent/projects/")) { window.location.replace("/agent"); return null; }
  if (window.location.pathname.startsWith("/simple/projects/")) return <AgentWorkspace ItineraryComponent={Itinerary} />;
  if (window.location.pathname.startsWith("/agent-planner")) return <AgentPlanner />;
  const params = new URLSearchParams(window.location.search);
  const exportMode = params.get("export") === "1";
  if (window.location.pathname === "/" && !exportMode && params.get("templatePreview") !== "1") {
    window.location.replace("/agent");
    return null;
  }
  const outputWidth = Number(params.get("width") || 2000);
  const scale = exportMode ? outputWidth / 2000 : 1;
  const datasetName = params.get("dataset");
  let workspaceData;
  if (datasetName === "workspace") {
    try { workspaceData = JSON.parse(localStorage.getItem("sheyou-export-data-v1")); } catch { workspaceData = null; }
  }
  const dataset = workspaceData || (datasetName === "xinjiang" ? sampleData : datasetName === "kenya-luxury-8d" ? kenyaLuxury8dData : datasetName === "tanzania-luxury-10d" ? tanzaniaLuxury10dData : africaData);
  const data = buildCustomerTravelEntityData(buildScenario(dataset, params.get("scenario")));
  if (params.get("styleProof") === "A") return <StyleProofA data={data} />;
  if (!exportMode && params.get("templatePreview") !== "1") return <Workspace initialData={createProductionDefaultData()} ItineraryComponent={Itinerary} agentMode={window.location.pathname === "/agent" || window.location.pathname === "/agent/"} />;
  return <>{!exportMode && <nav className="preview-toolbar"><div><strong>奢游国际行程长图模板</strong><span>{data.days.length}天真实资料 · 动态组件预览</span></div><div className="toolbar-actions"><a href="/?export=1&width=2000" target="_blank">2000px 原图</a><a href="/?export=1&width=1080" target="_blank">1080px 分享版</a></div></nav>}<div className={exportMode ? "export-mode" : "preview-stage"}><Itinerary data={data} scale={scale} /></div></>;
}
