import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWebServer } from '../server.js'
import { createStudio } from '../../studio/index.js'
import { createNode } from '../../studio/ui/authoring.js'
import { startTestBrowser } from './browser-helper.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const screenshotDirectory = join(repoRoot, 'look3-workspace', '整合', '20261022-恢复')

test('Look3 active Look2 shell keeps its layout and visual contracts at desktop and narrow sizes', {
  skip: !process.env.QXQY_BROWSER, timeout: 90_000,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'look3-layout-browser-'))
  const archive = createStudio().archiveData()
  const selected = createNode('textbox', { name: '布局选中项', text: '同一合成工程' })
  const unselected = createNode('textbox', { name: '布局普通项', text: '对照项目' })
  archive.assets.server.root.children[0].children = [selected, unselected]
  const savePath = join(directory, 'layout.save.json')
  writeFileSync(savePath, JSON.stringify(archive))

  const app = await createWebServer({ workspace: directory, initialPath: 'layout.save.json', port: 0 })
  let browser
  t.after(async () => {
    await browser?.close()
    await app.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  browser = await startTestBrowser(directory)
  await browser.navigate(`${app.url}/editor`)
  await browser.wait(`!!document.querySelector('.look2-brand small') && !!document.querySelector('.look2-dock')`)
  mkdirSync(screenshotDirectory, { recursive: true })

  const clickPoint = async (point, label = '目标') => {
    assert.ok(point?.hitTarget, `真实点击中心未命中${label}：${JSON.stringify(point)}`)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, browser.sessionId)
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 }, browser.sessionId)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 }, browser.sessionId)
  }

  const clickTreeItem = async name => {
    const point = await browser.evaluate(`(() => {
      const item = [...document.querySelectorAll('.look2-tree-row .tree-name')].find(node => node.textContent.trim() === ${JSON.stringify(name)});
      if (!item) return null;
      item.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = item.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2, hit = document.elementFromPoint(x, y);
      return { x, y, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
        hitTarget: Boolean(hit && (hit === item || item.contains(hit))), hitDescription: hit && { tag: hit.tagName, className: typeof hit.className === 'string' ? hit.className : '', title: hit.getAttribute('title') } };
    })()`)
    assert.ok(point && point.width > 0 && point.height > 0, `树项目不可见：${name}`)
    await clickPoint(point, `树项目 ${name}`)
  }

  const clickDockTab = async label => {
    const point = await browser.evaluate(`(() => {
      const root = document.querySelector('.look2-dock-tabs[role="tablist"]');
      const item = [...(root?.querySelectorAll('[role="tab"]') || [])].find(node => node.textContent.trim() === ${JSON.stringify(label)});
      if (!item) return null;
      item.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = item.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2, hit = document.elementFromPoint(x, y);
      return { x, y, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
        hitTarget: Boolean(hit && (hit === item || item.contains(hit))), hitDescription: hit && { tag: hit.tagName, className: typeof hit.className === 'string' ? hit.className : '', title: hit.getAttribute('title') } };
    })()`)
    assert.ok(point && point.width > 0 && point.height > 0, `面板入口不可见：${label}`)
    await clickPoint(point, `面板入口 ${label}`)
    await browser.wait(`document.querySelector('.look2-dock-tabs [role="tab"][aria-selected="true"]')?.textContent.trim() === ${JSON.stringify(label)}`)
  }

  const exercisePanelToggle = async ({ selector, collapseTitle, expandTitle }, width, height) => {
    const findButtonPoint = async title => browser.evaluate(`(() => {
      const pane = document.querySelector(${JSON.stringify(selector)});
      const button = [...(pane?.querySelectorAll('button') || [])].find(node => node.title === ${JSON.stringify(title)});
      if (!button) return null;
      button.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = button.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2, hit = document.elementFromPoint(x, y);
      return { x, y, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
        hitTarget: Boolean(hit && (hit === button || button.contains(hit))), hitDescription: hit && { tag: hit.tagName, className: typeof hit.className === 'string' ? hit.className : '', title: hit.getAttribute('title') } };
    })()`)
    const collapsePoint = await findButtonPoint(collapseTitle)
    assert.ok(collapsePoint && collapsePoint.width > 0 && collapsePoint.height > 0,
      `窄屏折叠入口不可见：${collapseTitle}`)
    await clickPoint(collapsePoint, `折叠入口 ${collapseTitle}`)
    await browser.wait(`document.querySelector(${JSON.stringify(selector)})?.classList.contains('collapsed')`)

    const expandPoint = await findButtonPoint(expandTitle)
    assert.ok(expandPoint && expandPoint.width > 0 && expandPoint.height > 0,
      `窄屏展开入口不可见：${expandTitle}`)
    assert.ok(expandPoint.left >= -1 && expandPoint.top >= -1 && expandPoint.right <= width + 1 && expandPoint.bottom <= height + 1,
      `窄屏展开入口应处于视口内：${expandTitle} ${JSON.stringify(expandPoint)}`)
    await clickPoint(expandPoint, `展开入口 ${expandTitle}`)
    await browser.wait(`!document.querySelector(${JSON.stringify(selector)})?.classList.contains('collapsed')`)
  }

  const results = []
  for (const [width, height, suffix] of [
    [1280, 720, '1280x720'],
    [1920, 1080, '1920x1080'],
    [390, 844, '390x844'],
  ]) {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, browser.sessionId)
    await browser.wait(`document.querySelector('.look2')?.clientWidth === ${width}`)

    await clickTreeItem('布局选中项')
    await browser.wait(`document.querySelector('.look2-tree-row.sel .tree-name')?.textContent.trim() === '布局选中项'`)
    await clickDockTab('调试')
    await clickDockTab('动画')
    await browser.wait(`!!document.querySelector('.look2-timeline')`)

    const screenshotPath = join(screenshotDirectory, `look3-layout-${suffix}.png`)
    const initialScreenshot = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, browser.sessionId)
    writeFileSync(screenshotPath, Buffer.from(initialScreenshot.data, 'base64'))

    if (width < 520) {
      for (const panel of [
        { selector: '.look2-main > .look2-pane:not(.look2-animations):not(.look2-inspector-pane)', collapseTitle: '折叠控件面板', expandTitle: '展开控件层级' },
        { selector: '.look2-main > .look2-animations', collapseTitle: '折叠动画面板', expandTitle: '展开动画面板' },
        { selector: '.look2-main > .look2-inspector-pane', collapseTitle: '收起属性面板', expandTitle: '展开属性面板' },
      ]) await exercisePanelToggle(panel, width, height)
    }

    const metrics = await browser.evaluate(`(() => {
      const rect = selector => {
        const element = document.querySelector(selector)
        return element ? element.getBoundingClientRect().toJSON() : null
      }
      const main = document.querySelector('.look2-main')
      const brand = document.querySelector('.look2-brand')
      const productName = brand?.querySelector('small')
      const selectedRow = document.querySelector('.look2-tree-row.sel')
      const plainRow = [...document.querySelectorAll('.look2-tree-row')].find(row => !row.classList.contains('sel'))
      const selectedStyle = selectedRow ? getComputedStyle(selectedRow) : null
      const plainStyle = plainRow ? getComputedStyle(plainRow) : null
      const brandStyle = brand ? getComputedStyle(brand) : null
      const titleStyle = brand?.querySelector('strong') ? getComputedStyle(brand.querySelector('strong')) : null
      const panels = {
        tree: rect('.look2-main > .look2-pane:not(.look2-animations):not(.look2-inspector-pane)'),
        canvas: rect('.look2-main > .look2-stage-column'),
        animator: rect('.look2-main > .look2-animations'),
        inspector: rect('.look2-main > .look2-inspector-pane'),
        timeline: rect('.look2-dock .look2-timeline'),
      }
      const mainRect = main?.getBoundingClientRect().toJSON() ?? null
      const rootFont = getComputedStyle(document.querySelector('.look2')).fontFamily
      return {
        viewport: { width: innerWidth, height: innerHeight },
        panels,
        main: mainRect,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        productName: productName?.textContent.trim() ?? '',
        productNameDisplay: productName ? getComputedStyle(productName).display : 'missing',
        brandFirstElement: brand?.firstElementChild?.tagName ?? null,
        brandMarkExists: !!brand?.querySelector('.look2-brand-mark'),
        brandHasIcon: !!brand?.querySelector(':scope > svg, :scope > img, :scope > .look2-icon'),
        brandGradient: brandStyle?.backgroundImage ?? '',
        fontFamily: rootFont,
        titleFont: titleStyle?.fontFamily ?? '',
        titleColor: titleStyle?.color ?? '',
        selectedRow: { background: selectedStyle?.backgroundColor, color: selectedStyle?.color },
        plainRow: { background: plainStyle?.backgroundColor, color: plainStyle?.color },
        activeDockTab: document.querySelector('.look2-dock-tabs [role="tab"][aria-selected="true"]')?.textContent.trim() ?? '',
      }
    })()`)

    const screenshot = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, browser.sessionId)
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))

    assert.equal(metrics.viewport.width, width)
    assert.equal(metrics.productName, '千星look3')
    assert.equal(metrics.brandFirstElement, 'STRONG', '标题栏左侧应从主标题开始，不再含星形图标')
    assert.equal(metrics.brandMarkExists, false, '标题栏不应再包含 Look2 星形品牌标记')
    assert.equal(metrics.brandHasIcon, false, '标题栏品牌区域不应再包含图标节点')
    assert.match(metrics.brandGradient, /linear-gradient/i, '保留 Look2 品牌渐变色')
    assert.ok(metrics.fontFamily && metrics.titleFont && metrics.titleColor, '活动编辑器应保留可计算的字体与文字颜色')
    assert.notEqual(metrics.selectedRow.background, metrics.plainRow.background, '树选中态应与普通行颜色区分')
    assert.notEqual(metrics.selectedRow.color, metrics.plainRow.color, '树选中态应与普通行文字颜色区分')
    assert.equal(metrics.activeDockTab, '动画')
    assert.equal(metrics.horizontalOverflow, false, `页面不应产生横向溢出：${JSON.stringify(metrics)}`)

    if (width >= 1100) {
      for (const [name, panel] of Object.entries(metrics.panels)) {
        assert.ok(panel && panel.width > 0 && panel.height > 0, `${name}区域应可见：${JSON.stringify(metrics)}`)
        assert.ok(panel.left >= -1 && panel.top >= -1 && panel.right <= width + 1 && panel.bottom <= height + 1,
          `${name}区域应处于当前视口内：${JSON.stringify(metrics)}`)
      }
      assert.notEqual(metrics.productNameDisplay, 'none', '桌面标题栏应显示产品名')
    } else {
      for (const name of ['tree', 'canvas', 'animator', 'inspector']) {
        const panel = metrics.panels[name]
        assert.ok(panel && panel.width > 0 && panel.height > 0, `${name}区域或展开入口应可达：${JSON.stringify(metrics)}`)
        assert.ok(panel.right > 0 && panel.bottom > 0 && panel.left < width && panel.top < height,
          `${name}区域应与窄屏视口相交：${JSON.stringify(metrics)}`)
      }
      assert.ok(metrics.panels.timeline && metrics.panels.timeline.width > 0 && metrics.panels.timeline.height > 0,
        `窄屏时间轴应可达：${JSON.stringify(metrics)}`)
      assert.ok(metrics.panels.timeline.right > 0 && metrics.panels.timeline.bottom > 0 && metrics.panels.timeline.left < width && metrics.panels.timeline.top < height,
        `窄屏时间轴应与视口相交：${JSON.stringify(metrics)}`)
    }

    results.push({ ...metrics, screenshot: screenshotPath })
  }

  console.log(`Look3 layout evidence: ${JSON.stringify(results)}`)
})
