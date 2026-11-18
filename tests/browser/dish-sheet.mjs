import assert from 'node:assert/strict';

/**
 * Dish details (#114 chunk B) is a photo-led bottom sheet. Assert the real layout of the open
 * dialog and the focus contract; the caller closes it and checks that focus returns to its trigger.
 */
export async function assertDishSheet(page, name) {
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  // Focus enters on the heading, which is the dish name.
  await page.waitForFunction(expected => document.activeElement?.textContent === expected && document.activeElement?.getAttribute('role') === 'heading', name);
  const box = await page.evaluate(expected => {
    const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const sheet = document.getElementById('panel-sheet');
    const heading = document.activeElement;
    const close = sheet.querySelector('[aria-label="Close dish details"]');
    const stepper = document.getElementById('dish-stepper');
    const add = Array.from(sheet.querySelectorAll('[role="button"]')).find(node => /^(Add · |Adding…)/.test(node.textContent));
    const image = sheet.querySelector('img') ?? sheet.querySelector('[role="img"]');
    return { viewport: { width: innerWidth, height: innerHeight }, sheet: rect(sheet), heading: rect(heading), close: close && rect(close), stepper: stepper && rect(stepper), add: add && rect(add), image: image && rect(image),
      radius: parseFloat(getComputedStyle(sheet).borderTopLeftRadius) };
  }, name);
  const { viewport, sheet } = box;
  assert.ok(Math.abs(sheet.bottom - viewport.height) <= 1, `sheet is bottom-anchored (${sheet.bottom} vs ${viewport.height})`);
  assert.ok(sheet.top > 0 && sheet.height <= viewport.height * 0.92 + 1, 'sheet leaves the page visible above it');
  if (viewport.width <= 600) assert.ok(sheet.left <= 1 && Math.abs(sheet.right - viewport.width) <= 1, 'sheet spans the phone width');
  assert.ok(box.radius >= 20, 'rounded top corners');
  assert.ok(box.image && box.image.bottom <= box.heading.top + 1, 'photo sits above the name');
  assert.ok(Math.abs(box.image.top - sheet.top) <= 1 && box.image.width >= sheet.width - 1, 'photo is edge to edge at the top of the sheet');
  assert.ok(box.close && box.close.width >= 44 && box.close.height >= 44, 'close target is at least 44px');
  assert.ok(box.close.top - sheet.top <= 24 && sheet.right - box.close.right <= 24, 'close sits in the top corner');
  assert.ok(box.stepper && box.add, 'quantity stepper and Add are shown');
  assert.ok(sheet.bottom - box.stepper.bottom <= 40 && sheet.bottom - box.add.bottom <= 40, 'quantity row sits at the bottom of the sheet');
  assert.ok(Math.abs((box.stepper.top + box.stepper.bottom) / 2 - (box.add.top + box.add.bottom) / 2) <= 2, 'stepper and Add share one row');
  assert.ok(box.add.height >= 44 && box.stepper.height >= 44, 'bottom row targets are at least 44px');
  assert.ok(box.stepper.top >= box.heading.bottom, 'quantity row is below the name');
  for (const label of ['Decrease quantity', 'Increase quantity']) {
    const target = await dialog.getByRole('button', { name: label, exact: true }).boundingBox();
    assert.ok(target.width >= 44 && target.height >= 44, `${label} target`);
  }
}

/** Escape closes the sheet and focus returns to the control that opened it. */
export async function closeDishSheet(page, triggerLabel) {
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(label => document.activeElement?.getAttribute('aria-label') === label, triggerLabel);
}

/** The dimmed backdrop above the sheet dismisses it too, and focus returns to the opener. */
export async function backdropCloseDishSheet(page, triggerLabel) {
  await page.mouse.click(8, 8);
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(label => document.activeElement?.getAttribute('aria-label') === label, triggerLabel);
}
