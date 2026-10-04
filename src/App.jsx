import { useState } from "react";
import {
  AndroidLogo,
  AppleLogo,
  ArrowRight,
  Buildings,
  CalendarCheck,
  Compass,
  DownloadSimple,
  Factory,
  Handshake,
  Leaf,
  LinuxLogo,
  List,
  LockKey,
  MapPin,
  ShieldCheck,
  Storefront,
  UsersThree,
  WindowsLogo,
  X,
} from "@phosphor-icons/react";

const journeySteps = [
  {
    number: "01",
    title: "发现灵感",
    copy: "探索真实的目的地与玩法，找到你的下一站灵感。",
    image: "/assets/journey-lake.webp",
    alt: "旅行者俯瞰高山湖泊与远山小镇",
    icon: Compass,
  },
  {
    number: "02",
    title: "实时可订",
    copy: "查看周边商家的真实信息、实时价格与可用库存。",
    image: "/assets/journey-phone.webp",
    alt: "手机上的途遇旅行发现界面",
    icon: CalendarCheck,
  },
  {
    number: "03",
    title: "预订与服务",
    copy: "直接连接经营者，确认行程与服务，不绕远路。",
    image: "/assets/journey-cafe.webp",
    alt: "山间旅宿经营者为旅行者确认服务",
    icon: Handshake,
  },
  {
    number: "04",
    title: "安心抵达",
    copy: "带着清楚的预订与凭证，顺畅抵达旅途中的每一站。",
    image: "/assets/journey-town.webp",
    alt: "旅行者抵达山地小镇",
    icon: MapPin,
  },
];

const merchantPlatforms = [
  {
    label: "macOS",
    detail: "Apple 芯片 Mac",
    href: "https://download.tuyulove.com/macos",
    available: false,
    icon: AppleLogo,
  },
  {
    label: "Windows",
    detail: "Windows x86-64",
    href: "https://download.tuyulove.com/windows",
    available: false,
    icon: WindowsLogo,
  },
  {
    label: "Linux",
    detail: "Linux ARM64",
    href: "https://download.tuyulove.com/linux",
    available: false,
    icon: LinuxLogo,
  },
];

function Brand({ footer = false }) {
  return (
    <a className={`brand ${footer ? "brand--footer" : ""}`} href="#top" aria-label="途遇首页">
      <img className="brand__mark" src="/assets/tuyu-logo.png" alt="" />
      <span className="brand__wordmark">
        <img className="brand__zh-image" src="/assets/tuyu-wordmark-zh.png" alt="" />
        <span className="brand__en">TUYULOVE</span>
      </span>
    </a>
  );
}

function NavLinks({ onNavigate }) {
  return (
    <>
      <a href="#journey" onClick={onNavigate}>发现途遇</a>
      <a href="#ecosystem" onClick={onNavigate}>途遇生态</a>
      <a href="#trust" onClick={onNavigate}>安全与信任</a>
      <a href="#download" onClick={onNavigate}>下载</a>
    </>
  );
}

function JourneyCard({ step }) {
  const Icon = step.icon;
  return (
    <article className="journey-card">
      <div className="journey-card__meta">
        <span>{step.number}</span>
        <Icon aria-hidden="true" weight="regular" />
      </div>
      <h3>{step.title}</h3>
      <p>{step.copy}</p>
      <img src={step.image} alt={step.alt} width="1200" height="900" loading="lazy" decoding="async" />
    </article>
  );
}

function PlatformLink({ platform }) {
  const Icon = platform.icon;
  const content = (
    <>
      <span className="platform-row__icon"><Icon aria-hidden="true" weight="fill" /></span>
      <span className="platform-row__text">
        <strong>{platform.label}</strong>
        <small>{platform.detail}</small>
      </span>
      <span className={platform.available ? "platform-row__action" : "status-label"}>
        {platform.available ? <>下载 <ArrowRight aria-hidden="true" /></> : "尚未发布"}
      </span>
    </>
  );

  if (!platform.available) {
    return (
      <button
        className="platform-row platform-row--disabled"
        type="button"
        data-download-endpoint={platform.href}
        aria-label={`途遇商家端 ${platform.label} 版本尚未发布`}
        disabled
      >
        {content}
      </button>
    );
  }

  return (
    <a className="platform-row" href={platform.href} aria-label={`下载途遇商家端 ${platform.label} 版本`}>
      {content}
    </a>
  );
}

export function App() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="site-shell" id="top">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <header className="site-header">
        <div className="site-header__inner">
          <Brand />
          <nav className="desktop-nav" aria-label="主导航">
            <NavLinks />
          </nav>
          <a className="header-download" href="#download">
            下载途遇
          </a>
          <button
            className="menu-toggle"
            type="button"
            aria-label={menuOpen ? "关闭导航" : "打开导航"}
            aria-expanded={menuOpen}
            aria-controls="mobile-navigation"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X aria-hidden="true" /> : <List aria-hidden="true" />}
          </button>
        </div>
        {menuOpen && (
          <nav className="mobile-nav" id="mobile-navigation" aria-label="移动端导航">
            <NavLinks onNavigate={() => setMenuOpen(false)} />
            <a className="mobile-nav__download" href="#download" onClick={() => setMenuOpen(false)}>
              下载途遇
            </a>
          </nav>
        )}
      </header>

      <main id="main-content">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero__copy">
            <p className="eyebrow">途遇 · 旅行</p>
            <h1 id="hero-title">
              从这里，<br />遇见下一段<span className="hero-title__journey">旅程。</span>
            </h1>
            <p className="hero__lead">一个途遇号，统一使用旅行与商家服务。</p>
            <div className="hero__actions">
              <a className="primary-button" href="#download">
                下载途遇 <DownloadSimple aria-hidden="true" />
              </a>
              <a className="text-link" href="#ecosystem">
                了解途遇生态 <ArrowRight aria-hidden="true" />
              </a>
            </div>
            <div className="hero__route-note">
              <MapPin aria-hidden="true" weight="fill" />
              <span>发现真实目的地，连接真实经营者</span>
            </div>
          </div>
          <figure className="hero__media">
            <img
              src="/assets/hero-hikers.webp"
              alt="两位旅行者沿山径走向云雾群山"
              width="1920"
              height="1200"
              fetchPriority="high"
            />
            <figcaption>每一次出发，<br />都让世界更大一点。</figcaption>
          </figure>
        </section>

        <section className="journey-section" id="journey" aria-labelledby="journey-title">
          <div className="section-heading section-heading--center">
            <p className="eyebrow">一段旅程，从灵感到抵达</p>
            <h2 id="journey-title">让每一次出行，更简单，也更安心。</h2>
            <p>途遇连接旅行者与真实商家，把发现、确认与服务放在同一段清晰旅程里。</p>
          </div>
          <div className="journey-grid">
            {journeySteps.map((step) => <JourneyCard key={step.number} step={step} />)}
          </div>
        </section>

        <section className="ecosystem-section" id="ecosystem" aria-labelledby="ecosystem-title">
          <div className="ecosystem-grid">
            <div className="ecosystem-intro">
              <p className="eyebrow">去中心化的经营关系</p>
              <h2 id="ecosystem-title">让生意，<br />回到经营者手中。</h2>
              <p>
                途遇不把订单、库存和经营数据集中到一个平台。每个商家、每个厂家，都拥有自己的系统与真实数据。
              </p>
              <strong><Leaf aria-hidden="true" />彼此连接，不被集中。</strong>
            </div>

            <article className="ecosystem-story">
              <img src="/assets/decentralized-merchant.webp" alt="独立商家与旅行者面对面确认服务" width="1400" height="1000" loading="lazy" decoding="async" />
              <div className="ecosystem-story__body">
                <span className="story-icon"><Storefront aria-hidden="true" /></span>
                <div>
                  <p className="eyebrow">途遇商家</p>
                  <h3>生意与数据，留在自己的主机。</h3>
                  <p>实时库存与订单，留在商家自己的主机；旅行者直连真实经营者。</p>
                </div>
              </div>
            </article>

            <article className="ecosystem-story">
              <img src="/assets/decentralized-factory.webp" alt="生产厂家在自己的工厂管理商品与发货" width="1400" height="1000" loading="lazy" decoding="async" />
              <div className="ecosystem-story__body">
                <span className="story-icon"><Factory aria-hidden="true" /></span>
                <div>
                  <p className="eyebrow">途遇厂家</p>
                  <h3>经营权，始终属于真实厂家。</h3>
                  <p>商品、价格、库存与发货，由厂家自己管理；与商家直接协作。</p>
                </div>
              </div>
            </article>
          </div>

          <div className="connection-principle" aria-label="途遇连接原则">
            <div><UsersThree aria-hidden="true" /><span>旅行者</span></div>
            <ArrowRight aria-hidden="true" />
            <div><Storefront aria-hidden="true" /><span>真实商家</span></div>
            <ArrowRight aria-hidden="true" />
            <div><Factory aria-hidden="true" /><span>真实厂家</span></div>
            <p>途遇负责连接，经营者保有权威。</p>
          </div>
        </section>

        <section className="trust-section" id="trust" aria-labelledby="trust-title">
          <div className="trust-section__icon"><ShieldCheck aria-hidden="true" weight="duotone" /></div>
          <div>
            <p className="eyebrow">安全与信任</p>
            <h2 id="trust-title">身份密钥，只留在你的设备。</h2>
            <p>身份密钥只保存在本设备安全存储中，每次登录均在本地完成签名；途遇只接收验证凭证。</p>
          </div>
          <div className="trust-section__facts">
            <span><LockKey aria-hidden="true" />本地签名</span>
            <span><Buildings aria-hidden="true" />数据归经营者</span>
          </div>
        </section>

        <section className="download-section" id="download" aria-labelledby="download-title">
          <div className="section-heading section-heading--center">
            <p className="eyebrow">下载途遇</p>
            <h2 id="download-title">选择适合你的客户端</h2>
            <p>旅行者与经营者，从对应的入口开始各自的途遇体验。</p>
          </div>

          <div className="download-grid">
            <article className="download-card download-card--traveler">
              <div className="download-card__heading">
                <span><Compass aria-hidden="true" /></span>
                <div>
                  <p className="eyebrow">途遇</p>
                  <h3>旅行者端</h3>
                </div>
              </div>
              <p>发现酒店、餐厅、旅行团与票务，向真实商家确认价格与预订。</p>
              <button className="platform-row platform-row--disabled" type="button" disabled>
                <span className="platform-row__icon"><AppleLogo aria-hidden="true" weight="fill" /></span>
                <span className="platform-row__text"><strong>iOS</strong><small>App Store</small></span>
                <span className="status-label">尚未发布</span>
              </button>
              <button className="platform-row platform-row--disabled" type="button" disabled>
                <span className="platform-row__icon"><AndroidLogo aria-hidden="true" weight="fill" /></span>
                <span className="platform-row__text"><strong>Android</strong><small>Google Play</small></span>
                <span className="status-label">尚未发布</span>
              </button>
            </article>

            <article className="download-card download-card--merchant">
              <div className="download-card__heading">
                <span><Storefront aria-hidden="true" /></span>
                <div>
                  <p className="eyebrow">途遇商家</p>
                  <h3>商家端</h3>
                </div>
              </div>
              <p>一个安装包，统一经营酒店、餐厅、旅行团与票务业务。</p>
              {merchantPlatforms.map((platform) => <PlatformLink key={platform.label} platform={platform} />)}
              <small className="availability-note">稳定下载入口已预留，安装包发布后开放下载。</small>
            </article>

            <article className="download-card download-card--future">
              <div className="download-card__heading">
                <span><UsersThree aria-hidden="true" /></span>
                <div>
                  <p className="eyebrow">途遇生态</p>
                  <h3>生态产品与能力</h3>
                </div>
              </div>
              <p>面向一线员工、生产厂家与商家采购协作的生态能力，按真实业务边界逐步开放。</p>
              <div className="future-row">
                <span><UsersThree aria-hidden="true" /></span>
                <div><strong>商家员工端</strong><small>iPadOS · Android Pad · 桌面端</small></div>
                <span className="status-label">规划中</span>
              </div>
              <div className="future-row">
                <span><Factory aria-hidden="true" /></span>
                <div><strong>途遇厂家端</strong><small>厂家自有商品、库存与履约</small></div>
                <span className="status-label">规划中</span>
              </div>
              <div className="future-row">
                <span><Buildings aria-hidden="true" /></span>
                <div><strong>途遇商城</strong><small>商家与厂家直接采购协作</small></div>
                <span className="status-label">规划中</span>
              </div>
            </article>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="site-footer__inner">
          <Brand footer />
          <p className="site-footer__tagline">从这里，遇见下一段旅程。</p>
          <nav aria-label="页脚导航">
            <a href="#journey">发现途遇</a>
            <a href="#ecosystem">途遇生态</a>
            <a href="#trust">安全与信任</a>
            <a href="#download">下载</a>
          </nav>
          <div className="site-footer__meta">
            <strong>tuyulove.com</strong>
            <small>© 2026 TUYULOVE</small>
          </div>
        </div>
      </footer>
    </div>
  );
}
