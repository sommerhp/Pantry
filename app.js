const { useState, useEffect, useMemo } = React;

// ---- design tokens ----
// ink:      #2B2A25  warm charcoal
// paper:    #EDE6D6  parchment
// card:     #E2D9C4  darker parchment
// staple:   #8A6D3B  grain/mustard
// fresh:    #4C6B4F  sage
// alert:    #B5482F  rust
// line:     #C9BFA8

const STORAGE_KEY = "pantry-data";
const API_KEY_STORAGE = "pantry-anthropic-key";

function getApiKey() {
  try {
    return localStorage.getItem(API_KEY_STORAGE) || "";
  } catch (e) {
    return "";
  }
}

function setStoredApiKey(key) {
  try {
    if (key) localStorage.setItem(API_KEY_STORAGE, key);
    else localStorage.removeItem(API_KEY_STORAGE);
  } catch (e) {
    // ignore — worst case the key just doesn't persist
  }
}
const DAY = 86400000;

const uid = () => Math.random().toString(36).slice(2, 10);

const emptyData = { items: [], shoppingList: [], recipes: [] };

// Rough consumer-guideline shelf lives in days once opened/bought, refrigerated.
// Starting points only — not a food-safety authority. Always editable.
const SHELF_LIFE_PRESETS = {
  milk: 7,
  eggs: 21,
  bread: 5,
  lettuce: 7,
  spinach: 5,
  "ground beef": 2,
  chicken: 2,
  fish: 2,
  berries: 3,
  strawberries: 3,
  yogurt: 14,
  butter: 30,
  tofu: 5,
  leftovers: 4,
  "deli meat": 5,
  cheese: 14,
};

function suggestShelfLife(name) {
  const n = normalizeName(name);
  if (!n) return null;
  if (SHELF_LIFE_PRESETS[n] !== undefined) return SHELF_LIFE_PRESETS[n];
  const key = Object.keys(SHELF_LIFE_PRESETS).find((k) => n.includes(k) || k.includes(n));
  return key ? SHELF_LIFE_PRESETS[key] : null;
}

function levenshtein(a, b) {
  const m = a.length,
    n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

function normalizeName(s) {
  return s.trim().toLowerCase().replace(/s$/, "");
}

function capitalize(s) {
  const t = s.trim();
  if (!t) return t;
  return t[0].toUpperCase() + t.slice(1);
}

// splits free-typed instructions into steps by line — each non-empty line is one step
function stepsFromText(text) {
  return (text || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Starter cross-language synonym groups (English/German/Spanish) — a curated list
// of common grocery terms, not a translation service. Anything not listed here
// still falls through to normal string matching, so it's a floor, not a ceiling.
const RECIPE_TAG_PRESETS = ["Breakfast", "Lunch", "Dinner", "Snack", "Dessert"];

const SYNONYM_GROUPS = [
  ["milk", "milch", "leche"],
  ["egg", "ei", "eier", "huevo", "huevos"],
  ["bread", "brot", "pan"],
  ["rice", "reis", "arroz"],
  ["sugar", "zucker", "azucar", "azúcar"],
  ["salt", "salz", "sal"],
  ["flour", "mehl", "harina"],
  ["butter", "mantequilla"],
  ["cheese", "kase", "käse", "queso"],
  ["water", "wasser", "agua"],
  ["onion", "onions", "zwiebel", "zwiebeln", "cebolla"],
  ["garlic", "knoblauch", "ajo"],
  ["tomato", "tomatoes", "tomate", "tomaten"],
  ["potato", "potatoes", "kartoffel", "kartoffeln", "patata", "papa"],
  ["chicken", "huhn", "hahnchen", "hähnchen", "pollo"],
  ["fish", "fisch", "pescado"],
  ["pepper", "pfeffer", "pimienta"],
  ["oil", "ol", "öl", "aceite"],
  ["yogurt", "joghurt", "yogur"],
  ["apple", "apples", "apfel", "äpfel", "manzana"],
  ["banana", "bananas", "banane", "platano", "plátano"],
  ["lettuce", "salat", "lechuga"],
  ["carrot", "carrots", "karotte", "karotten", "möhre", "zanahoria"],
  ["coffee", "kaffee", "cafe", "café"],
  ["tea", "tee", "te", "té"],
  ["pasta", "nudeln"],
  ["beans", "bohnen", "frijoles", "judias", "judías"],
  ["lemon", "zitrone", "limon", "limón"],
  ["spinach", "spinat", "espinaca"],
  ["cream", "sahne", "crema", "nata"],
];

const SYNONYM_INDEX = {};
SYNONYM_GROUPS.forEach((group, idx) => {
  group.forEach((word) => {
    SYNONYM_INDEX[normalizeName(word)] = idx;
  });
});

function synonymGroupOf(name) {
  const n = normalizeName(name);
  return n in SYNONYM_INDEX ? SYNONYM_INDEX[n] : null;
}

// exact (case-insensitive, trimmed) match — used to block identical names,
// distinct from the fuzzy similarity system used for suggestions
// a true exact match (case-insensitive) — there's never a legitimate reason to have
// two items with literally the same name, so this blocks saving entirely
function isExactDuplicate(name, list, excludeId) {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  return list.some((x) => x.id !== excludeId && x.name.trim().toLowerCase() === n);
}

// a same-language-group match (e.g. Milk / Milch) that ISN'T an exact match — could be
// a real duplicate or could be a false positive, so this only warns, never blocks
function isSynonymDuplicate(name, list, excludeId) {
  const n = name.trim().toLowerCase();
  const group = synonymGroupOf(name);
  if (group === null) return false;
  return list.some(
    (x) => x.id !== excludeId && x.name.trim().toLowerCase() !== n && synonymGroupOf(x.name) === group
  );
}

// same matching rules as isExactDuplicate/isSynonymDuplicate combined, but returns the
// item — used by creation paths that don't have a form to show a warning in, so they
// resolve to the existing item instead
function findExistingByName(name, list) {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const group = synonymGroupOf(name);
  return (
    list.find((x) => x.name.trim().toLowerCase() === n || (group !== null && synonymGroupOf(x.name) === group)) ||
    null
  );
}

function similarityScore(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ga = synonymGroupOf(a);
  const gb = synonymGroupOf(b);
  if (ga !== null && ga === gb) return 0.95;
  // multi-word names sharing a common word (e.g. "Raclette Cheese" / "Cottage Cheese")
  // score deceptively high on whole-string edit distance, since the shared word
  // dominates. Compare only the words that differ instead — a real typo in the
  // distinguishing word still scores high, but genuinely different words don't.
  const wordsA = na.split(/\s+/);
  const wordsB = nb.split(/\s+/);
  if (wordsA.length > 1 || wordsB.length > 1) {
    const setA = new Set(wordsA);
    const setB = new Set(wordsB);
    const uniqueA = wordsA.filter((w) => !setB.has(w));
    const uniqueB = wordsB.filter((w) => !setA.has(w));
    if (uniqueA.length > 0 && uniqueB.length > 0) {
      const distA = uniqueA.join(" ");
      const distB = uniqueB.join(" ");
      const dist = levenshtein(distA, distB);
      const maxLen = Math.max(distA.length, distB.length, 1);
      return 1 - dist / maxLen;
    }
  }
  // containment only counts as a real signal once the shorter string has enough
  // characters to not be a coincidence (e.g. "c" inside "cookies" is meaningless)
  const shorter = Math.min(na.length, nb.length);
  if (shorter >= 3 && (na.includes(nb) || nb.includes(na))) return 0.85;
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return 1 - dist / maxLen;
}

// heuristic only — catches typos and near-duplicates, not true synonyms
function findSimilarItem(name, items) {
  let best = null;
  let bestScore = 0;
  items.forEach((item) => {
    const score = similarityScore(name, item.name);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  });
  return best && bestScore >= 0.6 ? { item: best, score: bestScore } : null;
}

// for live-typing suggestions — a lower bar than findSimilarItem since these are
// just optional shortcuts the person can ignore, not a blocking confirmation
function topMatches(name, items, n) {
  return items
    .map((item) => ({ item, score: similarityScore(name, item.name) }))
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

// handles both the old flat-string amount format and the new { qty, unit } shape
function displayAmount(a) {
  if (!a) return "";
  if (typeof a === "string") return a;
  return [a.qty, a.unit].filter(Boolean).join(" ");
}

// scales a numeric qty by a factor; non-numeric amounts ("a pinch") pass through unscaled
function scaleQty(qty, factor) {
  const n = parseFloat(qty);
  if (isNaN(n) || !isFinite(factor)) return qty;
  const scaled = n * factor;
  const rounded = Math.round(scaled * 100) / 100;
  return String(rounded);
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const diff = new Date(dateStr).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0);
  return Math.round(diff / DAY);
}

function freshnessColor(days) {
  if (days === null) return "#C9BFA8";
  if (days < 0) return "#B5482F";
  if (days <= 3) return "#B5482F";
  if (days <= 7) return "#8A6D3B";
  return "#4C6B4F";
}

function freshnessLabel(days) {
  if (days === null) return "";
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "expires today";
  return `${days}d left`;
}

function isItemMissing(item) {
  if (item.category === "staple" || item.category === "spice" || item.category === "freezer") {
    return !item.available;
  }
  if (item.category === "fresh") {
    return !item.available || (daysUntil(item.expiryDate) ?? 0) < 0;
  }
  return false;
}

// once a pantry item now exists that matches an untracked ingredient by name, treat it
// as tracked — this is what makes "add it to your pantry later" actually take effect
// instead of the recipe forever remembering it as untracked
function reconcileFreeIngredients(ingredientIds, freeIngredients, amounts, items) {
  const promotedIds = [];
  const remainingFree = [];
  const newAmounts = { ...amounts };
  freeIngredients.forEach((name) => {
    const match = items.find((i) => normalizeName(i.name) === normalizeName(name));
    if (match) {
      promotedIds.push(match.id);
      const freeKey = `free:${name}`;
      if (newAmounts[freeKey] !== undefined) {
        newAmounts[match.id] = newAmounts[freeKey];
        delete newAmounts[freeKey];
      }
    } else {
      remainingFree.push(name);
    }
  });
  return {
    ingredientIds: [...ingredientIds, ...promotedIds],
    freeIngredients: remainingFree,
    amounts: newAmounts,
  };
}

function recipeStatus(recipe, items) {
  const reconciled = reconcileFreeIngredients(
    recipe.ingredientIds,
    recipe.freeIngredients || [],
    recipe.amounts || {},
    items
  );
  const effectiveIngredientIds = reconciled.ingredientIds;
  const resolved = effectiveIngredientIds.map((id) => items.find((i) => i.id === id));
  const missing = [];
  let ready = true;
  resolved.forEach((item) => {
    if (!item) {
      ready = false;
      missing.push("removed ingredient");
      return;
    }
    if (isItemMissing(item)) {
      ready = false;
      missing.push(item.name);
    }
  });
  const freeIngredients = reconciled.freeIngredients;
  // untracked ingredients are, by definition, not confirmed in the pantry
  if (freeIngredients.length > 0) {
    ready = false;
    missing.push(...freeIngredients);
  }
  const isStapleOnly = freeIngredients.length === 0 && resolved.every((i) => i && i.category === "staple");
  // optional ingredients never affect readiness — they're extras, not requirements
  const optReconciled = reconcileFreeIngredients(
    recipe.optionalIngredientIds || [],
    recipe.optionalFreeIngredients || [],
    reconciled.amounts,
    items
  );
  const effectiveOptionalIngredientIds = optReconciled.ingredientIds;
  const optionalResolved = effectiveOptionalIngredientIds.map((id) => items.find((i) => i.id === id));
  const optionalMissing = optionalResolved.filter((item) => !item || isItemMissing(item));
  const optionalFreeIngredients = optReconciled.freeIngredients;
  return {
    ready,
    missing,
    isStapleOnly,
    resolved,
    freeIngredients,
    optionalResolved,
    optionalMissing,
    optionalFreeIngredients,
    effectiveIngredientIds,
    effectiveOptionalIngredientIds,
    displayAmounts: optReconciled.amounts,
  };
}

// true when the recipe isn't ready, but nothing further needs to be added —
// every missing required ingredient (tracked or untracked) is already on the active list
function missingCoverage(status, shoppingList) {
  if (status.ready) return false;
  const missingRequired = status.resolved.filter((item) => !item || isItemMissing(item));
  if (missingRequired.some((item) => !item)) return false; // removed ingredient — nothing to link, can't be covered
  const requiredCovered = missingRequired.every((item) =>
    shoppingList.some((s) => s.linkedItemId === item.id && !s.bought)
  );
  const freeCovered = status.freeIngredients.every((name) =>
    shoppingList.some((s) => !s.linkedItemId && !s.bought && normalizeName(s.name) === normalizeName(name))
  );
  return requiredCovered && freeCovered;
}

function PantryKeeper() {
  const [data, setData] = useState(emptyData);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState("pantry");
  const [showAdd, setShowAdd] = useState(false);
  const [editingItemId, setEditingItemId] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showRecipe, setShowRecipe] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importDraft, setImportDraft] = useState(null);
  const [openRecipeId, setOpenRecipeId] = useState(null);
  const [viewRecipeId, setViewRecipeId] = useState(null);
  const [manualItem, setManualItem] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get(STORAGE_KEY, false);
        if (res && res.value) {
          const parsed = JSON.parse(res.value);
          // migrate old { low } shape to unified { available }
          parsed.items = (parsed.items || []).map((i) => ({
            ...(i.available === undefined ? { ...i, available: !i.low } : i),
            shelfLifeDays: i.shelfLifeDays !== undefined ? i.shelfLifeDays : null,
            freezeDate: i.freezeDate !== undefined ? i.freezeDate : null,
          }));
          parsed.recipes = (parsed.recipes || []).map((r) => ({
            ...r,
            freeIngredients: r.freeIngredients || [],
            optionalIngredientIds: r.optionalIngredientIds || [],
            optionalFreeIngredients: r.optionalFreeIngredients || [],
            amounts: r.amounts || {},
            yieldQty: r.yieldQty || null,
            yieldLabel: r.yieldLabel || "",
            tags: r.tags || [],
          }));
          setData(parsed);
        }
      } catch (e) {
        // no existing data yet, start fresh
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  // permanently promotes any freeIngredient that now matches a pantry item by name into
  // a real ingredientId reference. Runs on every persist so it self-heals immediately —
  // critically, once promoted the link is by id, so a later rename of the pantry item
  // no longer breaks it (the earlier bug was matching by name on every render instead)
  function reconcileAllRecipes(recipes, items) {
    return recipes.map((r) => {
      const reqBefore = (r.freeIngredients || []).length;
      const optBefore = (r.optionalFreeIngredients || []).length;
      const reqResult = reconcileFreeIngredients(r.ingredientIds, r.freeIngredients || [], r.amounts || {}, items);
      const optResult = reconcileFreeIngredients(
        r.optionalIngredientIds || [],
        r.optionalFreeIngredients || [],
        reqResult.amounts,
        items
      );
      if (reqResult.freeIngredients.length === reqBefore && optResult.freeIngredients.length === optBefore) {
        return r;
      }
      return {
        ...r,
        ingredientIds: reqResult.ingredientIds,
        freeIngredients: reqResult.freeIngredients,
        optionalIngredientIds: optResult.ingredientIds,
        optionalFreeIngredients: optResult.freeIngredients,
        amounts: optResult.amounts,
      };
    });
  }

  async function persist(next) {
    const reconciledNext = { ...next, recipes: reconcileAllRecipes(next.recipes, next.items) };
    setData(reconciledNext);
    try {
      await window.storage.set(STORAGE_KEY, JSON.stringify(reconciledNext), false);
    } catch (e) {
      setError("Couldn't save — your last change may not persist.");
      setTimeout(() => setError(""), 3000);
    }
  }

  function createPantryItem({ name, category, expiryDate, shelfLifeDays, staleDate, freezeDate, available }) {
    const existing = findExistingByName(name, data.items);
    if (existing) return existing.id;
    const item = {
      id: uid(),
      name: name.trim(),
      category,
      expiryDate: category === "fresh" ? expiryDate || null : null,
      shelfLifeDays: category === "fresh" ? shelfLifeDays ?? null : null,
      staleDate: category === "staple" ? staleDate || null : null,
      freezeDate: category === "freezer" ? freezeDate || null : null,
      available: available !== undefined ? available : true,
    };
    let shoppingList = data.shoppingList;
    // keep the invariant: an unavailable staple always has an active list entry
    if (item.category === "staple" && !item.available) {
      shoppingList = [
        ...shoppingList,
        { id: uid(), name: item.name, source: "staple-auto", linkedItemId: item.id, bought: false },
      ];
    }
    persist({ ...data, items: [...data.items, item], shoppingList });
    return item.id;
  }

  function addItem(fields) {
    createPantryItem(fields);
    setShowAdd(false);
  }

  function updateItem(id, { name, category, expiryDate, shelfLifeDays, staleDate, freezeDate }) {
    const items = data.items.map((i) => {
      if (i.id !== id) return i;
      const newCategory = category || i.category;
      return {
        ...i,
        name: name.trim(),
        category: newCategory,
        expiryDate:
          newCategory === "fresh" ? expiryDate ?? (i.category === "fresh" ? i.expiryDate : null) : null,
        shelfLifeDays:
          newCategory === "fresh"
            ? shelfLifeDays ?? (i.category === "fresh" ? i.shelfLifeDays : null)
            : null,
        staleDate:
          newCategory === "staple" ? staleDate ?? (i.category === "staple" ? i.staleDate : null) : null,
        freezeDate:
          newCategory === "freezer" ? freezeDate ?? (i.category === "freezer" ? i.freezeDate : null) : null,
      };
    });
    persist({ ...data, items });
    setEditingItemId(null);
  }

  function removeItem(id) {
    persist({ ...data, items: data.items.filter((i) => i.id !== id) });
  }

  function toggleAvailable(id) {
    const item = data.items.find((i) => i.id === id);
    const nowAvailable = !item.available;
    const items = data.items.map((i) => (i.id === id ? { ...i, available: nowAvailable } : i));
    let shoppingList = data.shoppingList;
    if (item.category === "staple") {
      if (!nowAvailable) {
        const hasActive = shoppingList.some((s) => s.linkedItemId === id && !s.bought);
        if (!hasActive) {
          shoppingList = [
            ...shoppingList,
            { id: uid(), name: item.name, source: "staple-auto", linkedItemId: id, bought: false },
          ];
        }
      } else {
        shoppingList = shoppingList.filter((s) => !(s.linkedItemId === id && !s.bought));
      }
    }
    // fresh items only use this for "mark used up" — restocking goes through restockFresh
    persist({ ...data, items, shoppingList });
  }

  function restockFresh(id, { expiryDate, shelfLifeDays }) {
    const items = data.items.map((i) =>
      i.id === id
        ? { ...i, available: true, expiryDate, shelfLifeDays: shelfLifeDays ?? i.shelfLifeDays ?? null }
        : i
    );
    const shoppingList = data.shoppingList.filter((s) => !(s.linkedItemId === id && !s.bought));
    persist({ ...data, items, shoppingList });
  }

  function addFreshToList(id) {
    const item = data.items.find((i) => i.id === id);
    const hasActive = data.shoppingList.some((s) => s.linkedItemId === id && !s.bought);
    if (hasActive) return;
    persist({
      ...data,
      shoppingList: [
        ...data.shoppingList,
        { id: uid(), name: item.name, source: "fresh-manual", linkedItemId: id, bought: false },
      ],
    });
  }

  function markUsedUp(id, addToList) {
    const item = data.items.find((i) => i.id === id);
    const items = data.items.map((i) => (i.id === id ? { ...i, available: false } : i));
    let shoppingList = data.shoppingList;
    if (addToList) {
      const hasActive = shoppingList.some((s) => s.linkedItemId === id && !s.bought);
      if (!hasActive) {
        shoppingList = [
          ...shoppingList,
          { id: uid(), name: item.name, source: "fresh-manual", linkedItemId: id, bought: false },
        ];
      }
    }
    persist({ ...data, items, shoppingList });
  }

  function addMissingToList(recipe) {
    const { resolved, freeIngredients } = recipeStatus(recipe, data.items);
    let shoppingList = data.shoppingList;
    resolved.forEach((item) => {
      if (!item || !isItemMissing(item)) return;
      const hasActive = shoppingList.some((s) => s.linkedItemId === item.id && !s.bought);
      if (!hasActive) {
        shoppingList = [
          ...shoppingList,
          { id: uid(), name: item.name, source: "recipe", recipeName: recipe.name, linkedItemId: item.id, bought: false },
        ];
      }
    });
    freeIngredients.forEach((name) => {
      const hasActive = shoppingList.some(
        (s) => !s.linkedItemId && !s.bought && normalizeName(s.name) === normalizeName(name)
      );
      if (!hasActive) {
        shoppingList = [
          ...shoppingList,
          { id: uid(), name, source: "recipe", recipeName: recipe.name, linkedItemId: null, bought: false },
        ];
      }
    });
    persist({ ...data, shoppingList });
  }

  function addOptionalMissingToList(recipe) {
    const { optionalResolved } = recipeStatus(recipe, data.items);
    let shoppingList = data.shoppingList;
    optionalResolved.forEach((item) => {
      if (!item || !isItemMissing(item)) return;
      const hasActive = shoppingList.some((s) => s.linkedItemId === item.id && !s.bought);
      if (!hasActive) {
        shoppingList = [
          ...shoppingList,
          { id: uid(), name: item.name, source: "recipe", recipeName: recipe.name, linkedItemId: item.id, bought: false },
        ];
      }
    });
    persist({ ...data, shoppingList });
  }

  function addManualShoppingItem() {
    const name = manualItem.trim();
    if (!name) return;
    persist({
      ...data,
      shoppingList: [
        ...data.shoppingList,
        { id: uid(), name, source: "manual", linkedItemId: null, bought: false },
      ],
    });
    setManualItem("");
  }

  function linkExistingToList(item) {
    if (item.category === "staple") {
      if (item.available) toggleAvailable(item.id);
      // if already unavailable, an active list entry already exists — nothing to do
    } else {
      addFreshToList(item.id);
    }
    setManualItem("");
  }

  function toggleBought(id) {
    const entry = data.shoppingList.find((s) => s.id === id);
    const nowBought = !entry.bought;
    let items = data.items;
    if (nowBought && entry.linkedItemId) {
      items = items.map((i) => (i.id === entry.linkedItemId ? { ...i, available: true } : i));
    }
    const shoppingList = data.shoppingList.map((s) =>
      s.id === id ? { ...s, bought: nowBought } : s
    );
    persist({ ...data, items, shoppingList });
  }

  // for entries with no linkedItemId (manual typing, or an untracked recipe ingredient) —
  // marking bought alone never creates a pantry item, so this does that explicitly and
  // links the entry retroactively, same result as if it had been tracked from the start
  function trackShoppingEntry(entryId, { name, category, expiryDate, shelfLifeDays, staleDate }) {
    const existing = findExistingByName(name, data.items);
    let items = data.items;
    let linkedId;
    if (existing) {
      linkedId = existing.id;
    } else {
      linkedId = uid();
      const item = {
        id: linkedId,
        name: name.trim(),
        category,
        expiryDate: category === "fresh" ? expiryDate || null : null,
        shelfLifeDays: category === "fresh" ? shelfLifeDays ?? null : null,
        staleDate: category === "staple" ? staleDate || null : null,
        available: true,
      };
      items = [...data.items, item];
    }
    const shoppingList = data.shoppingList.map((s) =>
      s.id === entryId ? { ...s, bought: true, linkedItemId: linkedId } : s
    );
    persist({ ...data, items, shoppingList });
  }

  function restockFromList(entryId, { expiryDate, shelfLifeDays }) {
    const entry = data.shoppingList.find((s) => s.id === entryId);
    if (!entry || !entry.linkedItemId) return;
    const items = data.items.map((i) =>
      i.id === entry.linkedItemId
        ? { ...i, available: true, expiryDate, shelfLifeDays: shelfLifeDays ?? i.shelfLifeDays ?? null }
        : i
    );
    const shoppingList = data.shoppingList.map((s) => (s.id === entryId ? { ...s, bought: true } : s));
    persist({ ...data, items, shoppingList });
  }

  function clearBoughtItems() {
    persist({ ...data, shoppingList: data.shoppingList.filter((s) => !s.bought) });
  }

  function removeShoppingItem(entry) {
    let items = data.items;
    if (entry.linkedItemId) {
      items = items.map((i) => (i.id === entry.linkedItemId ? { ...i, available: true } : i));
    }
    persist({
      ...data,
      items,
      shoppingList: data.shoppingList.filter((s) => s.id !== entry.id),
    });
  }

  function addRecipe({ name, ingredientIds, optionalIngredientIds, freeIngredients, optionalFreeIngredients, amounts, yieldQty, yieldLabel, tags, instructions }) {
    const id = uid();
    persist({
      ...data,
      recipes: [
        ...data.recipes,
        {
          id,
          name: name.trim(),
          ingredientIds,
          optionalIngredientIds: optionalIngredientIds || [],
          freeIngredients: freeIngredients || [],
          optionalFreeIngredients: optionalFreeIngredients || [],
          amounts: amounts || {},
          yieldQty: yieldQty || null,
          yieldLabel: yieldLabel || "",
          tags: tags || [],
          instructions: instructions.trim(),
        },
      ],
    });
    setShowRecipe(false);
    setViewRecipeId(id);
  }

  function removeRecipe(id) {
    persist({ ...data, recipes: data.recipes.filter((r) => r.id !== id) });
  }

  function updateRecipe(id, { name, ingredientIds, optionalIngredientIds, freeIngredients, optionalFreeIngredients, amounts, yieldQty, yieldLabel, tags, instructions }) {
    persist({
      ...data,
      recipes: data.recipes.map((r) =>
        r.id === id
          ? {
              ...r,
              name: name.trim(),
              ingredientIds,
              optionalIngredientIds: optionalIngredientIds || [],
              freeIngredients: freeIngredients || [],
              optionalFreeIngredients: optionalFreeIngredients || [],
              amounts: amounts || {},
              yieldQty: yieldQty || null,
              yieldLabel: yieldLabel || "",
              tags: tags || [],
              instructions: instructions.trim(),
            }
          : r
      ),
    });
    setOpenRecipeId(null);
    setViewRecipeId(id);
  }

  const fresh = useMemo(
    () =>
      [...data.items]
        .filter((i) => i.category === "fresh")
        .sort((a, b) => {
          if (a.available !== b.available) return a.available ? -1 : 1;
          return (daysUntil(a.expiryDate) ?? 9999) - (daysUntil(b.expiryDate) ?? 9999);
        }),
    [data.items]
  );
  const staples = useMemo(
    () => data.items.filter((i) => i.category === "staple"),
    [data.items]
  );
  const spices = useMemo(
    () => data.items.filter((i) => i.category === "spice"),
    [data.items]
  );
  const freezer = useMemo(
    () => data.items.filter((i) => i.category === "freezer"),
    [data.items]
  );
  const staplesForPicker = staples;

  if (!loaded) {
    return (
      <div style={{ ...S.app, alignItems: "center", justifyContent: "center", display: "flex" }}>
        <span style={{ fontFamily: FONT.mono, color: "#8A6D3B", letterSpacing: "0.08em" }}>
          loading pantry…
        </span>
      </div>
    );
  }

  return (
    <div style={S.app}>
      <FontImport />
      <header style={S.header}>
        <div>
          <div style={S.eyebrow}>kitchen ledger</div>
          <h1 style={S.h1}>Pantry Keeper</h1>
        </div>
      </header>

      <nav style={S.tabs}>
        {[
          ["pantry", "Pantry"],
          ["shopping", `List${data.shoppingList.filter((s) => !s.bought).length ? " · " + data.shoppingList.filter((s) => !s.bought).length : ""}`],
          ["recipes", "Staple recipes"],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              ...S.tab,
              ...(tab === key ? S.tabActive : {}),
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      {error && <div style={S.errorBanner}>{error}</div>}

      <main style={S.main}>
        {tab === "pantry" && (
          <PantryTab
            fresh={fresh}
            staples={staples}
            spices={spices}
            freezer={freezer}
            shoppingList={data.shoppingList}
            onToggleAvailable={toggleAvailable}
            onMarkUsedUp={markUsedUp}
            onAddFreshToList={addFreshToList}
            onRestockFresh={restockFresh}
            onEdit={setEditingItemId}
            onRemove={removeItem}
            onAdd={() => setShowAdd(true)}
          />
        )}
        {tab === "shopping" && (
          <ShoppingTab
            list={data.shoppingList}
            items={data.items}
            manualItem={manualItem}
            setManualItem={setManualItem}
            onAddManual={addManualShoppingItem}
            onLinkExisting={linkExistingToList}
            onToggleBought={toggleBought}
            onRestockFromList={restockFromList}
            onTrackEntry={trackShoppingEntry}
            onClearBought={clearBoughtItems}
            onRemove={removeShoppingItem}
          />
        )}
        {tab === "recipes" && (
          <RecipesTab
            recipes={data.recipes}
            items={data.items}
            shoppingList={data.shoppingList}
            onAdd={() => {
              setImportDraft(null);
              setShowRecipe(true);
            }}
            onImport={() => setShowImport(true)}
            onRemove={removeRecipe}
            onAddMissing={addMissingToList}
            onAddOptional={addOptionalMissingToList}
            onOpen={setViewRecipeId}
          />
        )}
      </main>

      <button style={S.settingsFab} onClick={() => setShowSettings(true)} aria-label="Settings">
        ⚙
      </button>

      {showAdd && (
        <AddItemModal items={data.items} onClose={() => setShowAdd(false)} onSave={addItem} />
      )}
      {editingItemId && (
        <EditItemModal
          item={data.items.find((i) => i.id === editingItemId)}
          items={data.items}
          onClose={() => setEditingItemId(null)}
          onSave={updateItem}
        />
      )}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showImport && (
        <ImportRecipeModal
          items={data.items}
          onClose={() => setShowImport(false)}
          onImported={(draft) => {
            setImportDraft(draft);
            setShowImport(false);
            setShowRecipe(true);
          }}
        />
      )}
      {showRecipe && (
        <AddRecipeModal
          items={data.items}
          recipes={data.recipes}
          initial={importDraft}
          onClose={() => {
            setShowRecipe(false);
            setImportDraft(null);
          }}
          onSave={addRecipe}
          onCreateItem={createPantryItem}
        />
      )}
      {viewRecipeId && !openRecipeId && (
        <RecipeViewModal
          recipe={data.recipes.find((r) => r.id === viewRecipeId)}
          items={data.items}
          shoppingList={data.shoppingList}
          onClose={() => setViewRecipeId(null)}
          onEdit={() => setOpenRecipeId(viewRecipeId)}
          onAddMissing={addMissingToList}
          onAddOptional={addOptionalMissingToList}
        />
      )}
      {openRecipeId && (
        <RecipeEditModal
          recipe={data.recipes.find((r) => r.id === openRecipeId)}
          items={data.items}
          recipes={data.recipes}
          onClose={() => {
            setOpenRecipeId(null);
            setViewRecipeId(null);
          }}
          onSave={(fields) => updateRecipe(openRecipeId, fields)}
          onDelete={() => {
            removeRecipe(openRecipeId);
            setOpenRecipeId(null);
            setViewRecipeId(null);
          }}
          onCreateItem={createPantryItem}
        />
      )}
    </div>
  );
}

// ---------------- Tabs ----------------

function PantryTab({
  fresh,
  staples,
  spices,
  freezer,
  shoppingList,
  onToggleAvailable,
  onMarkUsedUp,
  onAddFreshToList,
  onRestockFresh,
  onEdit,
  onRemove,
  onAdd,
}) {
  const [query, setQuery] = useState("");
  const [usedUpOpen, setUsedUpOpen] = useState(false);
  const [spicesOpen, setSpicesOpen] = useState(false);
  const q = query.trim().toLowerCase();

  const availableFresh = fresh.filter((i) => i.available);
  const usedUpFresh = fresh.filter((i) => !i.available);

  const visibleAvailableFresh = q ? availableFresh.filter((i) => i.name.toLowerCase().includes(q)) : availableFresh;
  const visibleUsedUpFresh = q ? usedUpFresh.filter((i) => i.name.toLowerCase().includes(q)) : usedUpFresh;
  const visibleStaples = q ? staples.filter((i) => i.name.toLowerCase().includes(q)) : staples;
  const visibleSpices = q ? spices.filter((i) => i.name.toLowerCase().includes(q)) : spices;
  const visibleFreezer = q ? freezer.filter((i) => i.name.toLowerCase().includes(q)) : freezer;
  const showSearch = fresh.length + staples.length + spices.length + freezer.length > 10;
  const showUsedUpSection = usedUpOpen || (!!q && visibleUsedUpFresh.length > 0);
  const showSpicesSection = spicesOpen || (!!q && visibleSpices.length > 0);

  const isOnList = (id) => shoppingList.some((s) => s.linkedItemId === id && !s.bought);

  return (
    <div>
      {showSearch && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your pantry…"
          style={{ ...S.input, marginBottom: "12px" }}
        />
      )}

      <SectionHead title="Fresh" sub="sorted by what spoils soonest" accent="#4C6B4F" />
      {visibleAvailableFresh.length === 0 ? (
        <EmptyRow
          text={
            q
              ? `No fresh items match "${query}".`
              : "Nothing fresh tracked yet. Add produce, dairy, anything with a shelf life."
          }
        />
      ) : (
        <div style={S.grid}>
          {visibleAvailableFresh.map((item) => (
            <FreshCard
              key={item.id}
              item={item}
              onMarkUsedUp={onMarkUsedUp}
              onAddToList={onAddFreshToList}
              isOnList={isOnList(item.id)}
              onEdit={onEdit}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}

      {usedUpFresh.length > 0 && (
        <div style={S.usedUpSection}>
          <button style={S.collapsibleHeader} onClick={() => setUsedUpOpen((o) => !o)}>
            {showUsedUpSection ? "▾" : "▸"} Used up ({usedUpFresh.length})
          </button>
          {showUsedUpSection &&
            (visibleUsedUpFresh.length === 0 ? (
              <div style={S.pickerNote}>No used-up items match "{query}".</div>
            ) : (
              <ul style={S.list}>
                {visibleUsedUpFresh.map((item) => (
                  <UsedUpFreshRow
                    key={item.id}
                    item={item}
                    onRestock={onRestockFresh}
                    onAddToList={onAddFreshToList}
                    isOnList={isOnList(item.id)}
                    onEdit={onEdit}
                    onRemove={onRemove}
                  />
                ))}
              </ul>
            ))}
        </div>
      )}

      <SectionHead title="Staples" sub="tap to mark not available — it lands on your list" accent="#8A6D3B" />
      {visibleStaples.length === 0 ? (
        <EmptyRow
          text={
            q
              ? `No staples match "${query}".`
              : "No staples yet. Rice, oil, canned goods — things that keep for months."
          }
        />
      ) : (
        <div style={S.grid}>
          {visibleStaples.map((item) => (
            <StapleCard key={item.id} item={item} onToggleAvailable={onToggleAvailable} onEdit={onEdit} onRemove={onRemove} />
          ))}
        </div>
      )}

      <SectionHead title="Freezer" sub="optional use-by date — add to list is manual, not automatic" accent="#4C6B4F" />
      {visibleFreezer.length === 0 ? (
        <EmptyRow
          text={q ? `No freezer items match "${query}".` : "Nothing in the freezer tracked yet."}
        />
      ) : (
        <div style={S.grid}>
          {visibleFreezer.map((item) => (
            <FreezerCard
              key={item.id}
              item={item}
              onToggleAvailable={onToggleAvailable}
              onAddToList={onAddFreshToList}
              isOnList={isOnList(item.id)}
              onEdit={onEdit}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}

      <div style={S.usedUpSection}>
        <button style={S.collapsibleHeader} onClick={() => setSpicesOpen((o) => !o)}>
          {showSpicesSection ? "▾" : "▸"} Spices ({spices.length})
        </button>
        {showSpicesSection &&
          (spices.length === 0 ? (
            <div style={S.pickerNote}>No spices tracked yet.</div>
          ) : visibleSpices.length === 0 ? (
            <div style={S.pickerNote}>No spices match "{query}".</div>
          ) : (
            <ul style={S.list}>
              {visibleSpices.map((item) => (
                <SpiceRow
                  key={item.id}
                  item={item}
                  onToggleAvailable={onToggleAvailable}
                  onEdit={onEdit}
                  onRemove={onRemove}
                />
              ))}
            </ul>
          ))}
      </div>

      <button style={S.fab} onClick={onAdd} aria-label="Add pantry item">
        +
      </button>
    </div>
  );
}

function SpiceRow({ item, onToggleAvailable, onEdit, onRemove }) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (confirmDelete) {
    return (
      <li style={S.restockRow}>
        <div style={S.listName}>Remove {item.name} from your pantry?</div>
        <div style={S.cardBtnRow}>
          <button style={{ ...S.lowBtn, flex: 1 }} onClick={() => onRemove(item.id)}>
            Yes, delete
          </button>
          <button style={{ ...S.lowBtn, flex: 1 }} onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li style={S.listRow}>
      <button
        style={{ ...S.checkbox, ...(item.available ? { background: "#8A6D3B" } : {}) }}
        onClick={() => onToggleAvailable(item.id)}
        aria-label="Toggle have it"
        title={item.available ? "Have it" : "Don't have it"}
      />
      <span style={{ ...S.listName, ...(item.available ? {} : { color: "#8A7F68" }) }}>{item.name}</span>
      <button style={S.editBtn} onClick={() => onEdit(item.id)} aria-label="Edit">
        ✎
      </button>
      <button style={S.removeBtn} onClick={() => setConfirmDelete(true)} aria-label="Remove">
        ×
      </button>
    </li>
  );
}

function ShoppingTab({
  list,
  items,
  manualItem,
  setManualItem,
  onAddManual,
  onLinkExisting,
  onToggleBought,
  onRestockFromList,
  onTrackEntry,
  onClearBought,
  onRemove,
}) {
  const active = list.filter((s) => !s.bought);
  const bought = list.filter((s) => s.bought);
  const [match, setMatch] = useState(null);
  const [showSuggestions, setShowSuggestions] = useState(false);

  const suggestions = manualItem.trim().length >= 2 ? topMatches(manualItem, items, 4) : [];

  function selectSuggestion(item) {
    onLinkExisting(item);
    setManualItem("");
    setShowSuggestions(false);
  }

  function handleSubmit() {
    const name = manualItem.trim();
    if (!name) return;
    setShowSuggestions(false);
    const found = findSimilarItem(name, items);
    if (found) {
      const hasActiveEntry = list.some((s) => s.linkedItemId === found.item.id && !s.bought);
      setMatch({ ...found, hasActiveEntry });
    } else {
      onAddManual();
    }
  }

  function confirmAddAnyway() {
    setMatch(null);
    onAddManual();
  }

  function confirmUseExisting() {
    onLinkExisting(match.item);
    setMatch(null);
  }

  return (
    <div>
      <div style={S.addRow}>
        <input
          value={manualItem}
          onChange={(e) => {
            setManualItem(e.target.value);
            if (match) setMatch(null);
            setShowSuggestions(true);
          }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setShowSuggestions(false)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          placeholder="Add something to the list…"
          style={S.input}
        />
        <button style={S.smallBtn} onClick={handleSubmit}>
          Add
        </button>
      </div>

      {showSuggestions && !match && suggestions.length > 0 && (
        <div style={S.suggestDropdown}>
          {suggestions.map(({ item }) => (
            <button
              key={item.id}
              style={S.suggestItem}
              onMouseDown={(e) => {
                e.preventDefault();
                selectSuggestion(item);
              }}
            >
              {item.name}
              <span style={S.suggestMeta}>
                {item.category}
                {item.category === "staple" && !item.available ? " · not available" : ""}
                {item.category === "fresh" && !item.available ? " · used up" : ""}
              </span>
            </button>
          ))}
        </div>
      )}

      {match && match.hasActiveEntry && (
        <div style={S.matchBanner}>
          <div style={S.matchText}>
            <strong>{match.item.name}</strong> is already on your list.
          </div>
          <div style={S.matchBtnRow}>
            <button style={S.confirmCancelBtn} onClick={() => setMatch(null)}>
              Got it
            </button>
            <button style={S.confirmDeleteBtn} onClick={confirmAddAnyway}>
              Add a second entry anyway
            </button>
          </div>
        </div>
      )}

      {match && !match.hasActiveEntry && match.item.available && (
        <div style={S.matchBannerWarn}>
          <div style={S.matchText}>
            You still have <strong>{match.item.name}</strong> — not empty yet.
          </div>
          <div style={S.matchBtnRow}>
            <button style={S.confirmDeleteBtn} onClick={confirmAddAnyway}>
              Add anyway, I need more
            </button>
            <button style={S.confirmCancelBtn} onClick={() => setMatch(null)}>
              Never mind
            </button>
          </div>
        </div>
      )}

      {match && !match.hasActiveEntry && !match.item.available && (
        <div style={S.matchBanner}>
          <div style={S.matchText}>
            Looks like you already track <strong>{match.item.name}</strong> (
            {match.item.category === "fresh" ? "used up" : "not available"}).
          </div>
          <div style={S.matchBtnRow}>
            <button style={S.confirmDeleteBtn} onClick={confirmUseExisting}>
              Use that instead
            </button>
            <button style={S.confirmCancelBtn} onClick={confirmAddAnyway}>
              Add as new anyway
            </button>
          </div>
        </div>
      )}

      <SectionHead title="To buy" sub={`${active.length} item${active.length === 1 ? "" : "s"}`} accent="#8A6D3B" />
      {active.length === 0 ? (
        <EmptyRow text="Nothing on the list. Low staples will show up here automatically." />
      ) : (
        <ul style={S.list}>
          {active.map((s) => (
            <ShoppingRow
              key={s.id}
              entry={s}
              items={items}
              onToggleBought={onToggleBought}
              onRestockFromList={onRestockFromList}
              onTrackEntry={onTrackEntry}
              onRemove={onRemove}
            />
          ))}
        </ul>
      )}

      {bought.length > 0 && (
        <>
          <div style={S.sectionHeadRow}>
            <SectionHead title="Bought" sub="" accent="#C9BFA8" />
            <button style={S.resetListBtn} onClick={onClearBought}>
              Reset list
            </button>
          </div>
          <ul style={S.list}>
            {bought.map((s) => (
              <li key={s.id} style={{ ...S.listRow, opacity: 0.5 }}>
                <button style={{ ...S.checkbox, background: "#8A6D3B" }} onClick={() => onToggleBought(s.id)} />
                <span style={{ ...S.listName, textDecoration: "line-through" }}>{s.name}</span>
                <button style={S.removeBtn} onClick={() => onRemove(s)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ShoppingRow({ entry, items, onToggleBought, onRestockFromList, onTrackEntry, onRemove }) {
  const linked = entry.linkedItemId ? items.find((i) => i.id === entry.linkedItemId) : null;
  const isFreshLinked = linked && linked.category === "fresh";

  const [showForm, setShowForm] = useState(false);
  const [trackStep, setTrackStep] = useState(null); // null | 'choose' | 'fresh'
  const [freshMode, setFreshMode] = useState("standard");
  const [exactDate, setExactDate] = useState("");
  const [days, setDays] = useState("");

  function handleMarkBought() {
    if (entry.bought) {
      onToggleBought(entry.id);
      return;
    }
    if (isFreshLinked) {
      setShowForm(true);
    } else if (!linked) {
      setTrackStep("choose");
    } else {
      onToggleBought(entry.id);
    }
  }

  function quickTrack(category) {
    onTrackEntry(entry.id, { name: entry.name, category });
    setTrackStep(null);
  }

  function skipTracking() {
    onToggleBought(entry.id);
    setTrackStep(null);
  }

  function confirmFreshTrack() {
    if (freshMode === "exact") {
      if (!exactDate) return;
      onTrackEntry(entry.id, { name: entry.name, category: "fresh", expiryDate: exactDate, shelfLifeDays: null });
    } else {
      if (!days || Number(days) <= 0) return;
      onTrackEntry(entry.id, {
        name: entry.name,
        category: "fresh",
        expiryDate: addDaysISO(days),
        shelfLifeDays: Number(days),
      });
    }
    setTrackStep(null);
  }

  if (trackStep === "choose") {
    return (
      <li style={S.restockRow}>
        <div style={S.listName}>Track "{entry.name}" in your pantry?</div>
        <div style={S.segment}>
          <button style={S.segmentBtn} onClick={() => quickTrack("staple")}>
            Staple
          </button>
          <button style={S.segmentBtn} onClick={() => setTrackStep("fresh")}>
            Fresh
          </button>
          <button style={S.segmentBtn} onClick={() => quickTrack("spice")}>
            Spice
          </button>
        </div>
        <button style={{ ...S.lowBtn, width: "100%" }} onClick={skipTracking}>
          No, just check it off
        </button>
      </li>
    );
  }

  if (trackStep === "fresh") {
    const canConfirm = freshMode === "exact" ? !!exactDate : !!days && Number(days) > 0;
    return (
      <li style={S.restockRow}>
        <FreshExpiryFields
          name={entry.name}
          mode={freshMode}
          setMode={setFreshMode}
          exactDate={exactDate}
          setExactDate={setExactDate}
          days={days}
          setDays={setDays}
        />
        <div style={S.cardBtnRow}>
          <button
            style={{ ...S.lowBtn, flex: 1, opacity: canConfirm ? 1 : 0.4 }}
            disabled={!canConfirm}
            onClick={confirmFreshTrack}
          >
            Confirm
          </button>
          <button style={{ ...S.lowBtn, flex: 1 }} onClick={() => setTrackStep("choose")}>
            Back
          </button>
        </div>
      </li>
    );
  }

  if (showForm && isFreshLinked) {
    return (
      <li style={S.restockRow}>
        <RestockPrompt
          name={entry.name}
          shelfLifeDays={linked.shelfLifeDays}
          onConfirm={(fields) => {
            onRestockFromList(entry.id, fields);
            setShowForm(false);
          }}
          onCancel={() => setShowForm(false)}
        />
      </li>
    );
  }

  return (
    <li style={S.listRow}>
      {isFreshLinked ? (
        <button style={S.restockChip} onClick={handleMarkBought} aria-label="Mark bought" title="Bought">
          ↻
        </button>
      ) : (
        <button style={S.checkbox} onClick={handleMarkBought} aria-label="Mark bought" />
      )}
      <span style={S.listName}>{entry.name}</span>
      {entry.source !== "manual" && (
        <span style={S.tagAuto}>
          {entry.source === "staple-auto"
            ? "not available"
            : entry.source === "recipe"
            ? entry.recipeName || "for recipe"
            : "from pantry"}
        </span>
      )}
      <button style={S.removeBtn} onClick={() => onRemove(entry)} aria-label="Remove">
        ×
      </button>
    </li>
  );
}

function RecipesTab({ recipes, items, shoppingList, onAdd, onImport, onRemove, onAddMissing, onAddOptional, onOpen }) {
  const [filterReady, setFilterReady] = useState(false);
  const [filterTag, setFilterTag] = useState(null);
  const [query, setQuery] = useState("");

  const withStatus = recipes.map((r) => ({ r, status: recipeStatus(r, items) }));
  const readyCount = withStatus.filter((x) => x.status.ready).length;
  const allTags = [...new Set(recipes.flatMap((r) => r.tags || []))].sort();

  const q = query.trim().toLowerCase();
  function matchesQuery({ r, status }) {
    if (!q) return true;
    if (r.name.toLowerCase().includes(q)) return true;
    if (status.resolved.some((i) => i && i.name.toLowerCase().includes(q))) return true;
    if (status.freeIngredients.some((n) => n.toLowerCase().includes(q))) return true;
    return false;
  }

  const visible = withStatus
    .filter(matchesQuery)
    .filter((x) => (filterReady ? x.status.ready : true))
    .filter((x) => (filterTag ? (x.r.tags || []).includes(filterTag) : true));

  return (
    <div>
      <div style={S.sectionHeadRow}>
        <SectionHead title="Recipes" sub="green means you can cook it right now" accent="#8A6D3B" />
        {recipes.length > 0 && (
          <div style={S.segmentSmall}>
            <button
              style={{ ...S.segmentSmallBtn, ...(!filterReady ? S.segmentSmallActive : {}) }}
              onClick={() => setFilterReady(false)}
            >
              All
            </button>
            <button
              style={{ ...S.segmentSmallBtn, ...(filterReady ? S.segmentSmallActive : {}) }}
              onClick={() => setFilterReady(true)}
            >
              Ready ({readyCount})
            </button>
          </div>
        )}
      </div>

      {allTags.length > 0 && (
        <div style={S.tagFilterRow}>
          <button
            style={{ ...S.tagFilterChip, ...(filterTag === null ? S.tagFilterChipActive : {}) }}
            onClick={() => setFilterTag(null)}
          >
            All categories
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              style={{ ...S.tagFilterChip, ...(filterTag === tag ? S.tagFilterChipActive : {}) }}
              onClick={() => setFilterTag(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      <button style={S.importLink} onClick={onImport}>
        Import from photo or text
      </button>

      {recipes.length > 6 && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search recipes or ingredients…"
          style={{ ...S.input, marginBottom: "12px" }}
        />
      )}

      {recipes.length === 0 ? (
        <EmptyRow text="No recipes saved yet. Add one, or import from a photo or pasted text." />
      ) : visible.length === 0 ? (
        <EmptyRow
          text={
            q
              ? `No recipes match "${query}".`
              : filterTag
              ? `No recipes tagged "${filterTag}"${filterReady ? " that are also ready" : ""}.`
              : "Nothing's fully stocked right now. Switch back to All to see everything."
          }
        />
      ) : (
        <div style={S.grid}>
          {visible.map(({ r, status }) => (
            <RecipeCard
              key={r.id}
              r={r}
              status={status}
              shoppingList={shoppingList}
              onOpen={onOpen}
              onRemove={onRemove}
              onAddMissing={onAddMissing}
              onAddOptional={onAddOptional}
            />
          ))}
        </div>
      )}
      <button style={S.fab} onClick={onAdd} aria-label="Add recipe">
        +
      </button>
    </div>
  );
}

function RecipeCard({ r, status, shoppingList, onOpen, onRemove, onAddMissing, onAddOptional }) {
  const { ready, isStapleOnly, optionalMissing } = status;
  const [showOptionalPrompt, setShowOptionalPrompt] = useState(false);
  const hasMissingOptional = optionalMissing.length > 0;
  const covered = missingCoverage(status, shoppingList);
  const statusColor = ready ? "#4C6B4F" : covered ? "#B5824A" : "#B5482F";

  function handleAddMissingClick(e) {
    e.stopPropagation();
    onAddMissing(r);
    if (hasMissingOptional) setShowOptionalPrompt(true);
  }

  function confirmAddOptional(e) {
    e.stopPropagation();
    onAddOptional(r);
    setShowOptionalPrompt(false);
  }

  function declineAddOptional(e) {
    e.stopPropagation();
    setShowOptionalPrompt(false);
  }

  return (
    <div style={{ ...S.card, cursor: "pointer" }} onClick={() => onOpen(r.id)}>
      <div style={S.cardTitleRow}>
        <span style={{ ...S.statusDot, background: statusColor }} />
        <span style={{ ...S.cardTitle, flex: 1 }}>{r.name}</span>
        <button
          style={S.removeBtn}
          onClick={(e) => {
            e.stopPropagation();
            onRemove(r.id);
          }}
        >
          ×
        </button>
      </div>
      {isStapleOnly && <span style={S.tagAuto}>staple recipe</span>}
      {r.tags && r.tags.length > 0 && (
        <div style={S.chipRow}>
          {r.tags.map((tag) => (
            <span key={tag} style={S.tagAuto}>
              {tag}
            </span>
          ))}
        </div>
      )}
      <div style={{ ...S.cardMeta, color: statusColor }}>
        {ready ? "ready to cook" : covered ? "missing, but already on your list" : "missing something"}
      </div>
      {(!ready && !covered) || hasMissingOptional ? (
        <button style={S.addMissingBtn} onClick={handleAddMissingClick}>
          Add missing ingredients to list
        </button>
      ) : null}
      {showOptionalPrompt && (
        <div style={S.matchBanner} onClick={(e) => e.stopPropagation()}>
          <div style={S.matchText}>
            Also add optional ingredients: {optionalMissing.map((i) => (i ? i.name : "(removed)")).join(", ")}?
          </div>
          <div style={S.matchBtnRow}>
            <button style={S.confirmDeleteBtn} onClick={confirmAddOptional}>
              Yes, add them
            </button>
            <button style={S.confirmCancelBtn} onClick={declineAddOptional}>
              No thanks
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- Cards ----------------

function FreshCard({ item, onMarkUsedUp, onAddToList, isOnList, onEdit, onRemove }) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const daysLeft = daysUntil(item.expiryDate);
  const color = freshnessColor(daysLeft);
  const pct = daysLeft === null ? 0 : Math.max(0, Math.min(100, 100 - (daysLeft / 14) * 100));

  if (confirmDelete) {
    return (
      <div style={S.card}>
        <div style={S.cardTitle}>{item.name}</div>
        <div style={S.matchText}>Remove this from your pantry?</div>
        <div style={S.cardBtnRow}>
          <button style={{ ...S.lowBtn, flex: 1 }} onClick={() => onRemove(item.id)}>
            Yes, delete
          </button>
          <button style={{ ...S.lowBtn, flex: 1 }} onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (showConfirm) {
    return (
      <div style={S.card}>
        <div style={S.cardTitle}>{item.name}</div>
        <div style={S.matchText}>Used it up — add to shopping list too?</div>
        <div style={S.cardBtnRow}>
          <button
            style={{ ...S.lowBtn, flex: 1 }}
            onClick={() => {
              onMarkUsedUp(item.id, true);
              setShowConfirm(false);
            }}
          >
            Yes, add
          </button>
          <button
            style={{ ...S.lowBtn, flex: 1 }}
            onClick={() => {
              onMarkUsedUp(item.id, false);
              setShowConfirm(false);
            }}
          >
            No, skip
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={S.card}>
      <div style={S.cardTitleRow}>
        <span style={S.cardTitle}>{item.name}</span>
        <button style={S.editBtn} onClick={() => onEdit(item.id)} aria-label="Edit">
          ✎
        </button>
        <button style={S.removeBtn} onClick={() => setConfirmDelete(true)}>
          ×
        </button>
      </div>
      <div style={S.decayTrack}>
        <div style={{ ...S.decayFill, width: `${pct}%`, background: color }} />
      </div>
      <div style={{ ...S.cardMeta, color }}>{freshnessLabel(daysLeft)}</div>
      <div style={S.cardBtnRow}>
        <button onClick={() => setShowConfirm(true)} style={{ ...S.lowBtn, flex: 1 }}>
          Mark used up
        </button>
        <button
          onClick={() => !isOnList && onAddToList(item.id)}
          disabled={isOnList}
          style={{ ...S.lowBtn, flex: 1, ...(isOnList ? S.lowBtnActive : {}) }}
        >
          {isOnList ? "On list ✓" : "Add to list"}
        </button>
      </div>
    </div>
  );
}

function UsedUpFreshRow({ item, onRestock, onAddToList, isOnList, onEdit, onRemove }) {
  const [showRestock, setShowRestock] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (confirmDelete) {
    return (
      <li style={S.restockRow}>
        <div style={S.listName}>Remove {item.name} from your pantry?</div>
        <div style={S.cardBtnRow}>
          <button style={{ ...S.lowBtn, flex: 1 }} onClick={() => onRemove(item.id)}>
            Yes, delete
          </button>
          <button style={{ ...S.lowBtn, flex: 1 }} onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
        </div>
      </li>
    );
  }

  if (showRestock) {
    return (
      <li style={S.restockRow}>
        <RestockPrompt
          name={item.name}
          shelfLifeDays={item.shelfLifeDays}
          onConfirm={(fields) => {
            onRestock(item.id, fields);
            setShowRestock(false);
          }}
          onCancel={() => setShowRestock(false)}
        />
      </li>
    );
  }

  return (
    <li style={S.listRow}>
      <button style={S.restockChip} onClick={() => setShowRestock(true)} aria-label="Restock" title="Restock">
        ↻
      </button>
      <span style={S.listName}>{item.name}</span>
      {item.shelfLifeDays && <span style={S.tagAuto}>{item.shelfLifeDays}d</span>}
      {isOnList ? (
        <span style={S.tagAuto}>on list</span>
      ) : (
        <button style={S.smallBtn} onClick={() => onAddToList(item.id)}>
          Add to list
        </button>
      )}
      <button style={S.editBtn} onClick={() => onEdit(item.id)} aria-label="Edit">
        ✎
      </button>
      <button style={S.removeBtn} onClick={() => setConfirmDelete(true)} aria-label="Remove">
        ×
      </button>
    </li>
  );
}

function FreezerCard({ item, onToggleAvailable, onAddToList, isOnList, onEdit, onRemove }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const useByDays = item.freezeDate ? daysUntil(item.freezeDate) : null;

  if (confirmDelete) {
    return (
      <div style={S.card}>
        <div style={S.cardTitle}>{item.name}</div>
        <div style={S.matchText}>Remove this from your pantry?</div>
        <div style={S.cardBtnRow}>
          <button style={{ ...S.lowBtn, flex: 1 }} onClick={() => onRemove(item.id)}>
            Yes, delete
          </button>
          <button style={{ ...S.lowBtn, flex: 1 }} onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...S.card, ...(item.available ? {} : S.cardUnavailable) }}>
      <div style={S.cardTitleRow}>
        <span style={S.cardTitle}>{item.name}</span>
        <button style={S.editBtn} onClick={() => onEdit(item.id)} aria-label="Edit">
          ✎
        </button>
        <button style={S.removeBtn} onClick={() => setConfirmDelete(true)}>
          ×
        </button>
      </div>
      {useByDays !== null && (
        <div style={{ ...S.cardMeta, color: freshnessColor(useByDays) }}>
          {useByDays < 0 ? "past use-by date" : `use by ~${useByDays}d`}
        </div>
      )}
      <div style={S.cardBtnRow}>
        <button
          onClick={() => onToggleAvailable(item.id)}
          style={{ ...S.lowBtn, flex: 1, ...(item.available ? {} : S.lowBtnActive) }}
        >
          {item.available ? "Mark not available" : "Available again"}
        </button>
        <button
          onClick={() => !isOnList && onAddToList(item.id)}
          disabled={isOnList}
          style={{ ...S.lowBtn, flex: 1, ...(isOnList ? S.lowBtnActive : {}) }}
        >
          {isOnList ? "On list ✓" : "Add to list"}
        </button>
      </div>
    </div>
  );
}

function StapleCard({ item, onToggleAvailable, onEdit, onRemove }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const staleDays = item.staleDate ? daysUntil(item.staleDate) : null;

  if (confirmDelete) {
    return (
      <div style={S.card}>
        <div style={S.cardTitle}>{item.name}</div>
        <div style={S.matchText}>Remove this from your pantry?</div>
        <div style={S.cardBtnRow}>
          <button style={{ ...S.lowBtn, flex: 1 }} onClick={() => onRemove(item.id)}>
            Yes, delete
          </button>
          <button style={{ ...S.lowBtn, flex: 1 }} onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...S.card, ...(item.available ? {} : S.cardUnavailable) }}>
      <div style={S.cardTitleRow}>
        <span style={S.cardTitle}>{item.name}</span>
        <button style={S.editBtn} onClick={() => onEdit(item.id)} aria-label="Edit">
          ✎
        </button>
        <button style={S.removeBtn} onClick={() => setConfirmDelete(true)}>
          ×
        </button>
      </div>
      {staleDays !== null && (
        <div style={{ ...S.cardMeta, color: freshnessColor(staleDays) }}>
          {staleDays < 0 ? "may be stale" : `keep fresh ~${staleDays}d`}
        </div>
      )}
      <button
        onClick={() => onToggleAvailable(item.id)}
        style={{ ...S.lowBtn, ...(item.available ? {} : S.lowBtnActive) }}
      >
        {item.available ? "Mark not available" : "On the list ✓"}
      </button>
    </div>
  );
}

// ---------------- Modals ----------------

function FreshExpiryFields({ name, mode, setMode, exactDate, setExactDate, days, setDays }) {
  const suggestion = suggestShelfLife(name);
  return (
    <>
      <label style={S.label}>Keeps for</label>
      <div style={S.segment}>
        <button
          onClick={() => setMode("exact")}
          style={{ ...S.segmentBtn, ...(mode === "exact" ? S.segmentActive : {}) }}
        >
          Exact date
        </button>
        <button
          onClick={() => setMode("standard")}
          style={{ ...S.segmentBtn, ...(mode === "standard" ? S.segmentActive : {}) }}
        >
          Standard (days)
        </button>
      </div>

      {mode === "exact" ? (
        <input type="date" style={S.input} value={exactDate} onChange={(e) => setExactDate(e.target.value)} />
      ) : (
        <>
          <div style={S.addRow}>
            <input
              type="number"
              min="1"
              style={S.input}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              placeholder={suggestion ? `e.g. ${suggestion}` : "e.g. 4"}
            />
            <span style={S.daysLabel}>days from today</span>
          </div>
          {suggestion !== null && !days && (
            <button style={S.suggestBtn} onClick={() => setDays(String(suggestion))}>
              Use typical: {suggestion}d
            </button>
          )}
          <div style={S.pickerNote}>
            Rough guideline, not a food-safety rule — adjust freely. Next time you restock this item, the
            date recalculates automatically — no re-entry needed.
          </div>
        </>
      )}
    </>
  );
}

function RestockPrompt({ name, shelfLifeDays, onConfirm, onCancel }) {
  const hasStandard = !!shelfLifeDays;
  const [choice, setChoice] = useState(hasStandard ? null : "standard");
  const [mode, setMode] = useState("standard");
  const [exactDate, setExactDate] = useState("");
  const [days, setDays] = useState(hasStandard ? String(shelfLifeDays) : "");

  // known shelf life — ask which applies this time, don't just silently reuse it
  if (hasStandard && choice === null) {
    return (
      <div style={S.restockForm}>
        <div style={S.listName}>Restock {name}</div>
        <div style={S.matchBtnRow}>
          <button
            style={{ ...S.lowBtn, flex: 1 }}
            onClick={() => onConfirm({ expiryDate: addDaysISO(shelfLifeDays), shelfLifeDays })}
          >
            Standard ({shelfLifeDays}d)
          </button>
          <button style={{ ...S.lowBtn, flex: 1 }} onClick={() => setChoice("exact")}>
            Specific date
          </button>
        </div>
        <button style={{ ...S.confirmCancelBtn, marginTop: "6px" }} onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  }

  if (hasStandard && choice === "exact") {
    return (
      <div style={S.restockForm}>
        <label style={S.label}>Expires on</label>
        <input type="date" style={S.input} value={exactDate} onChange={(e) => setExactDate(e.target.value)} />
        <div style={S.cardBtnRow}>
          <button
            style={{ ...S.lowBtn, flex: 1, opacity: exactDate ? 1 : 0.4 }}
            disabled={!exactDate}
            onClick={() => onConfirm({ expiryDate: exactDate, shelfLifeDays })}
          >
            Confirm
          </button>
          <button style={{ ...S.lowBtn, flex: 1 }} onClick={() => setChoice(null)}>
            Back
          </button>
        </div>
      </div>
    );
  }

  // no standard saved yet — offer to set one, same as adding a new item
  const canConfirm = mode === "exact" ? !!exactDate : !!days && Number(days) > 0;
  return (
    <div style={S.restockForm}>
      <FreshExpiryFields
        name={name}
        mode={mode}
        setMode={setMode}
        exactDate={exactDate}
        setExactDate={setExactDate}
        days={days}
        setDays={setDays}
      />
      <div style={S.cardBtnRow}>
        <button
          style={{ ...S.lowBtn, flex: 1, opacity: canConfirm ? 1 : 0.4 }}
          disabled={!canConfirm}
          onClick={() => {
            if (mode === "exact") onConfirm({ expiryDate: exactDate, shelfLifeDays: null });
            else onConfirm({ expiryDate: addDaysISO(days), shelfLifeDays: Number(days) });
          }}
        >
          Confirm
        </button>
        <button style={{ ...S.lowBtn, flex: 1 }} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function SettingsModal({ onClose }) {
  const [key, setKey] = useState(getApiKey());
  const [saved, setSaved] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [backupText, setBackupText] = useState("");
  const [copyMsg, setCopyMsg] = useState("");
  const [restoreText, setRestoreText] = useState("");
  const [restoreMsg, setRestoreMsg] = useState("");
  const [confirmRestore, setConfirmRestore] = useState(false);

  function handleSave() {
    setStoredApiKey(key.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function handleClear() {
    setKey("");
    setStoredApiKey("");
  }

  function openBackup() {
    let raw = "";
    try {
      raw = localStorage.getItem(STORAGE_KEY) || "";
    } catch (e) {
      raw = "";
    }
    setBackupText(raw);
    setShowBackup(true);
    setCopyMsg("");
    setRestoreMsg("");
  }

  async function copyBackup() {
    try {
      await navigator.clipboard.writeText(backupText);
      setCopyMsg("Copied ✓ — paste it somewhere safe, like Notes.");
    } catch (e) {
      setCopyMsg("Couldn't auto-copy — tap the box above, select all, and copy manually.");
    }
  }

  function handleRestore() {
    try {
      const parsed = JSON.parse(restoreText);
      if (!parsed || typeof parsed !== "object" || !("items" in parsed)) {
        setRestoreMsg("That doesn't look like a Pantry Keeper backup — check you pasted the whole thing.");
        return;
      }
      localStorage.setItem(STORAGE_KEY, restoreText);
      setRestoreMsg("Restored ✓ — close Settings and reopen the app to see it.");
      setConfirmRestore(false);
    } catch (e) {
      setRestoreMsg("That's not valid data — check you copied the whole backup with nothing missing.");
    }
  }

  return (
    <Modal onClose={onClose} title="Settings">
      <label style={S.label}>Backup your data</label>
      <div style={S.pickerNote}>
        Your pantry lives only on this phone, in this browser. If you ever clear this site's data, switch
        phones, or reinstall the app, everything is lost unless you've backed it up here first.
      </div>
      {!showBackup ? (
        <button style={{ ...S.primaryBtn, marginBottom: "16px" }} onClick={openBackup}>
          Back up now
        </button>
      ) : (
        <>
          <textarea
            style={{ ...S.textarea, fontFamily: FONT.mono, fontSize: "10px" }}
            rows={5}
            readOnly
            value={backupText}
            onFocus={(e) => e.target.select()}
          />
          <div style={S.cardBtnRow}>
            <button style={{ ...S.primaryBtn, flex: 1 }} onClick={copyBackup}>
              Copy to clipboard
            </button>
            <button style={{ ...S.lowBtn, flex: 1 }} onClick={() => setShowBackup(false)}>
              Hide
            </button>
          </div>
          {copyMsg && <div style={S.pickerNote}>{copyMsg}</div>}
        </>
      )}

      <label style={S.label}>Restore from a backup</label>
      <div style={S.pickerNote}>
        Paste a backup you saved earlier. This replaces everything currently in the app — only do this if
        you mean to.
      </div>
      <textarea
        style={{ ...S.textarea, fontFamily: FONT.mono, fontSize: "10px" }}
        rows={4}
        value={restoreText}
        onChange={(e) => setRestoreText(e.target.value)}
        placeholder="Paste your backup text here…"
      />
      {!confirmRestore ? (
        <button
          style={{ ...S.lowBtn, width: "100%", marginBottom: "16px" }}
          disabled={!restoreText.trim()}
          onClick={() => setConfirmRestore(true)}
        >
          Restore this backup
        </button>
      ) : (
        <div style={S.cardBtnRow}>
          <button style={{ ...S.confirmDeleteBtn, flex: 1 }} onClick={handleRestore}>
            Yes, replace everything
          </button>
          <button style={{ ...S.confirmCancelBtn, flex: 1 }} onClick={() => setConfirmRestore(false)}>
            Cancel
          </button>
        </div>
      )}
      {restoreMsg && <div style={S.pickerNote}>{restoreMsg}</div>}

      <label style={S.label}>Anthropic API key</label>
      <div style={S.pickerNote}>
        Needed only for the photo/text recipe import. Stored solely on this phone, in this browser — it
        never leaves your device except when talking directly to Anthropic's API. Get one at{" "}
        <strong>console.anthropic.com</strong> under API Keys, and set a spend limit there while you're at
        it. Clearing this just disables import — everything else keeps working.
      </div>
      <input
        type="password"
        autoComplete="off"
        style={S.input}
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="sk-ant-…"
      />
      <div style={S.cardBtnRow}>
        <button style={{ ...S.primaryBtn, flex: 1 }} onClick={handleSave}>
          {saved ? "Saved ✓" : "Save key"}
        </button>
        <button style={{ ...S.lowBtn, flex: 1 }} onClick={handleClear}>
          Clear
        </button>
      </div>
    </Modal>
  );
}

function AddItemModal({ items, onClose, onSave }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("staple");
  const [mode, setMode] = useState("standard");
  const [exactDate, setExactDate] = useState("");
  const [days, setDays] = useState("");
  const [staleDate, setStaleDate] = useState("");
  const [freezeDate, setFreezeDate] = useState("");

  const isExactDupe = isExactDuplicate(name, items);
  const isFuzzyDupe = isSynonymDuplicate(name, items);
  const canSave =
    name.trim() &&
    !isExactDupe &&
    (category !== "fresh" || (mode === "exact" ? exactDate : days && Number(days) > 0));

  function handleSave() {
    if (category === "fresh") {
      if (mode === "exact") {
        onSave({ name, category, expiryDate: exactDate, shelfLifeDays: null, staleDate: "", freezeDate: "" });
      } else {
        onSave({
          name,
          category,
          expiryDate: addDaysISO(days),
          shelfLifeDays: Number(days),
          staleDate: "",
          freezeDate: "",
        });
      }
    } else if (category === "spice") {
      onSave({ name, category, expiryDate: "", shelfLifeDays: null, staleDate: "", freezeDate: "" });
    } else if (category === "freezer") {
      onSave({ name, category, expiryDate: "", shelfLifeDays: null, staleDate: "", freezeDate });
    } else {
      onSave({ name, category, expiryDate: "", shelfLifeDays: null, staleDate, freezeDate: "" });
    }
  }

  return (
    <Modal onClose={onClose} title="Add pantry item">
      <label style={S.label}>Name</label>
      <input
        autoFocus
        style={S.input}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Rolled oats"
      />
      {isExactDupe && (
        <div style={S.dupeWarning}>
          You already have "{name.trim()}" in your pantry. Edit that item instead, or use a different
          name if this is genuinely something else.
        </div>
      )}
      {!isExactDupe && isFuzzyDupe && (
        <div style={S.dupeWarning}>
          You already have something similar to "{name.trim()}" in your pantry — you can still add this
          as a separate item if you mean something different.
        </div>
      )}

      <label style={S.label}>Category</label>
      <div style={S.segment}>
        {["staple", "fresh", "spice", "freezer"].map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            style={{ ...S.segmentBtn, ...(category === c ? S.segmentActive : {}) }}
          >
            {c === "staple" ? "Staple (2mo+)" : c === "fresh" ? "Fresh" : c === "spice" ? "Spice" : "Freezer"}
          </button>
        ))}
      </div>

      {category === "fresh" ? (
        <FreshExpiryFields
          name={name}
          mode={mode}
          setMode={setMode}
          exactDate={exactDate}
          setExactDate={setExactDate}
          days={days}
          setDays={setDays}
        />
      ) : category === "spice" ? (
        <div style={S.pickerNote}>Just tracked as have it / don't have it — no dates needed.</div>
      ) : category === "freezer" ? (
        <>
          <label style={S.label}>Use by (optional)</label>
          <div style={S.pickerNote}>
            Just a reference date — doesn't affect anything else, and doesn't add itself to your list
            automatically. Use "Add to list" on the item when you actually want more.
          </div>
          <input
            type="date"
            style={S.input}
            value={freezeDate}
            onChange={(e) => setFreezeDate(e.target.value)}
          />
        </>
      ) : (
        <>
          <label style={S.label}>Goes stale by (optional)</label>
          <input
            type="date"
            style={S.input}
            value={staleDate}
            onChange={(e) => setStaleDate(e.target.value)}
          />
        </>
      )}

      <button
        style={{ ...S.primaryBtn, opacity: canSave ? 1 : 0.4 }}
        disabled={!canSave}
        onClick={handleSave}
      >
        Add to pantry
      </button>
    </Modal>
  );
}

function EditItemModal({ item, items, onClose, onSave }) {
  const [name, setName] = useState(item.name);
  const [category, setCategory] = useState(item.category);
  const [mode, setMode] = useState(item.shelfLifeDays ? "standard" : "exact");
  const [exactDate, setExactDate] = useState(item.expiryDate || "");
  const [days, setDays] = useState(item.shelfLifeDays ? String(item.shelfLifeDays) : "");
  const [staleDate, setStaleDate] = useState(item.staleDate || "");
  const [freezeDate, setFreezeDate] = useState(item.freezeDate || "");

  const isExactDupe = isExactDuplicate(name, items, item.id);
  const isFuzzyDupe = isSynonymDuplicate(name, items, item.id);
  const canSave =
    name.trim() &&
    !isExactDupe &&
    (category !== "fresh" || (mode === "exact" ? exactDate : days && Number(days) > 0));

  function handleSave() {
    if (category === "fresh") {
      if (mode === "exact") {
        onSave(item.id, { name, category, expiryDate: exactDate, shelfLifeDays: null });
      } else {
        const keepDate = category === item.category ? item.expiryDate : addDaysISO(days);
        onSave(item.id, { name, category, expiryDate: keepDate, shelfLifeDays: Number(days) });
      }
    } else if (category === "staple") {
      onSave(item.id, { name, category, staleDate });
    } else if (category === "freezer") {
      onSave(item.id, { name, category, freezeDate });
    } else {
      onSave(item.id, { name, category });
    }
  }

  return (
    <Modal onClose={onClose} title="Edit pantry item">
      <label style={S.label}>Name</label>
      <input
        autoFocus
        style={S.input}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      {isExactDupe && (
        <div style={S.dupeWarning}>
          You already have "{name.trim()}" in your pantry. Edit that item instead, or use a different
          name if this is genuinely something else.
        </div>
      )}
      {!isExactDupe && isFuzzyDupe && (
        <div style={S.dupeWarning}>
          You already have something similar to "{name.trim()}" in your pantry — you can still save this
          as a separate item if you mean something different.
        </div>
      )}

      <label style={S.label}>Category</label>
      <div style={S.segment}>
        {["staple", "fresh", "spice", "freezer"].map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            style={{ ...S.segmentBtn, ...(category === c ? S.segmentActive : {}) }}
          >
            {c === "staple" ? "Staple (2mo+)" : c === "fresh" ? "Fresh" : c === "spice" ? "Spice" : "Freezer"}
          </button>
        ))}
      </div>
      {category !== item.category && (
        <div style={S.pickerNote}>
          Switching category clears the old category's tracking fields — you'll need to set new ones below.
        </div>
      )}

      {category === "fresh" && (
        <FreshExpiryFields
          name={name}
          mode={mode}
          setMode={setMode}
          exactDate={exactDate}
          setExactDate={setExactDate}
          days={days}
          setDays={setDays}
        />
      )}

      {category === "staple" && (
        <>
          <label style={S.label}>Goes stale by (optional)</label>
          <input
            type="date"
            style={S.input}
            value={staleDate}
            onChange={(e) => setStaleDate(e.target.value)}
          />
        </>
      )}

      {category === "freezer" && (
        <>
          <label style={S.label}>Use by (optional)</label>
          <div style={S.pickerNote}>
            Just a reference date — doesn't add itself to your list automatically. Use "Add to list" on
            the item when you actually want more.
          </div>
          <input
            type="date"
            style={S.input}
            value={freezeDate}
            onChange={(e) => setFreezeDate(e.target.value)}
          />
        </>
      )}

      {category === "spice" && (
        <div style={S.pickerNote}>Just tracked as have it / don't have it — no dates needed.</div>
      )}

      <button
        style={{ ...S.primaryBtn, opacity: canSave ? 1 : 0.4 }}
        disabled={!canSave}
        onClick={handleSave}
      >
        Save changes
      </button>
    </Modal>
  );
}

function IngredientPicker({
  items,
  picked,
  onToggleInclude,
  optionalPicked,
  onToggleOptionalFlag,
  onUseExisting,
  onCreateItem,
  freeIngredients,
  optionalFreeIngredients,
  onAddFree,
  onRenameFree,
  onToggleFreeOptional,
  onRemoveFreeAny,
  onTrackFree,
  amounts,
  setAmounts,
}) {
  const [freeInput, setFreeInput] = useState("");
  const [freeMatch, setFreeMatch] = useState(null);
  const [pendingNoMatch, setPendingNoMatch] = useState(null);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [qaCategory, setQaCategory] = useState("staple");
  const [query, setQuery] = useState("");
  const staples = items.filter((i) => i.category === "staple");
  const fresh = items.filter((i) => i.category === "fresh");
  const spices = items.filter((i) => i.category === "spice");
  const freezerItems = items.filter((i) => i.category === "freezer");

  const q = query.trim().toLowerCase();
  // keep already-selected items visible even if they don't match the current search
  const isSelected = (item) => picked.includes(item.id) || optionalPicked.includes(item.id);
  const matchesQuery = (item) => !q || item.name.toLowerCase().includes(q) || isSelected(item);
  const visibleStaples = staples.filter(matchesQuery);
  const visibleFresh = fresh.filter(matchesQuery);
  const visibleSpices = spices.filter(matchesQuery);
  const visibleFreezer = freezerItems.filter(matchesQuery);

  function setQty(key, qty) {
    setAmounts((a) => ({ ...a, [key]: { ...(typeof a[key] === "object" ? a[key] : {}), qty } }));
  }
  function setUnit(key, unit) {
    setAmounts((a) => ({ ...a, [key]: { ...(typeof a[key] === "object" ? a[key] : {}), unit } }));
  }
  function amountFor(key) {
    const a = amounts[key];
    if (!a) return { qty: "", unit: "" };
    if (typeof a === "string") return { qty: a, unit: "" };
    return { qty: a.qty || "", unit: a.unit || "" };
  }

  function resetFreeFlow() {
    setFreeInput("");
    setFreeMatch(null);
    setPendingNoMatch(null);
    setShowQuickAdd(false);
    setQaCategory("staple");
  }

  function handleAddFree() {
    const name = freeInput.trim();
    if (!name) return;
    const found = findSimilarItem(name, items);
    if (found) {
      setFreeMatch(found);
      setPendingNoMatch(null);
    } else {
      setPendingNoMatch(name);
      setFreeMatch(null);
    }
  }

  function useMatchInstead() {
    onUseExisting(freeMatch.item.id);
    resetFreeFlow();
  }

  function addFreeAnyway(name) {
    onAddFree(capitalize(name));
    resetFreeFlow();
  }

  function confirmQuickAdd() {
    // no date asked here — you don't have it yet, so there's nothing to date.
    // it gets set the first time you restock it after shopping.
    const fields = {
      name: capitalize(pendingNoMatch),
      category: qaCategory,
      expiryDate: "",
      shelfLifeDays: null,
      staleDate: "",
      available: false,
    };
    const newId = onCreateItem(fields);
    onUseExisting(newId);
    resetFreeFlow();
  }

  function renderGroup(label, groupItems) {
    if (groupItems.length === 0) return null;
    return (
      <div key={label}>
        <div style={S.pickerGroupLabel}>{label}</div>
        <div style={S.pickerList}>
          {groupItems.map((item) => {
            const included = picked.includes(item.id) || optionalPicked.includes(item.id);
            const isOptional = optionalPicked.includes(item.id);
            const amt = amountFor(item.id);
            return (
              <label key={item.id} style={S.pickerRow}>
                <input type="checkbox" checked={included} onChange={() => onToggleInclude(item.id)} />
                {included && (
                  <>
                    <input
                      style={S.qtyInput}
                      value={amt.qty}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setQty(item.id, e.target.value)}
                      placeholder="qty"
                    />
                    <input
                      style={S.unitInput}
                      value={amt.unit}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setUnit(item.id, e.target.value)}
                      placeholder="unit"
                    />
                  </>
                )}
                <span style={{ flex: 1 }}>{item.name}</span>
                {included && (
                  <span
                    style={{ ...S.optionalInlineToggle, ...(isOptional ? S.optionalInlineToggleActive : {}) }}
                    onClick={(e) => {
                      e.preventDefault();
                      onToggleOptionalFlag(item.id);
                    }}
                  >
                    optional
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <>
      <label style={S.label}>Ingredients — pick from your pantry</label>
      <div style={S.pickerNote}>
        Only tracked items can be picked here — that's what lets the light stay accurate. Amounts are for
        your own reference while cooking and don't affect tracking. Check "optional" on anything that
        shouldn't block the recipe from being ready.
      </div>

      {items.length > 8 && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your pantry…"
          style={{ ...S.input, marginBottom: "8px" }}
        />
      )}

      {renderGroup("Staples", visibleStaples)}
      {renderGroup("Fresh", visibleFresh)}
      {renderGroup("Spices", visibleSpices)}
      {renderGroup("Freezer", visibleFreezer)}

      {q &&
        visibleStaples.length === 0 &&
        visibleFresh.length === 0 &&
        visibleSpices.length === 0 &&
        visibleFreezer.length === 0 && (
          <div style={S.pickerNote}>No pantry items match "{query}".</div>
        )}

      <label style={S.label}>Other ingredients (optional)</label>
      <div style={S.pickerNote}>
        Not tracked in your pantry — treated as not-in-stock, so a recipe with any of these can't show ready until you track it or remove it.
      </div>
      <div style={S.addRow}>
        <input
          value={freeInput}
          onChange={(e) => {
            setFreeInput(e.target.value);
            if (freeMatch) setFreeMatch(null);
            if (pendingNoMatch) setPendingNoMatch(null);
            if (showQuickAdd) setShowQuickAdd(false);
          }}
          onKeyDown={(e) => e.key === "Enter" && handleAddFree()}
          placeholder="e.g. salt, pepper"
          style={S.input}
        />
        <button style={S.smallBtn} onClick={handleAddFree}>
          Add
        </button>
      </div>

      {freeMatch && (
        <div style={S.matchBanner}>
          <div style={S.matchText}>
            Looks like you already track <strong>{freeMatch.item.name}</strong> — check it above instead?
          </div>
          <div style={S.matchBtnRow}>
            <button style={S.confirmDeleteBtn} onClick={useMatchInstead}>
              Use that instead
            </button>
            <button style={S.confirmCancelBtn} onClick={() => addFreeAnyway(freeInput.trim())}>
              Add as untracked anyway
            </button>
          </div>
        </div>
      )}

      {pendingNoMatch && !showQuickAdd && (
        <div style={S.matchBanner}>
          <div style={S.matchText}>
            <strong>{pendingNoMatch}</strong> isn't in your pantry yet.
          </div>
          <div style={S.matchBtnRow}>
            <button style={S.confirmDeleteBtn} onClick={() => setShowQuickAdd(true)}>
              Add to pantry
            </button>
            <button style={S.confirmCancelBtn} onClick={() => addFreeAnyway(pendingNoMatch)}>
              Use as untracked
            </button>
          </div>
        </div>
      )}

      {pendingNoMatch && showQuickAdd && (
        <div style={S.matchBanner}>
          <div style={S.matchText}>
            Add <strong>{pendingNoMatch}</strong> to your pantry (marked not-in-stock — you'll set a date
            when you actually shop for it):
          </div>
          <div style={S.segment}>
            {["staple", "fresh", "spice", "freezer"].map((c) => (
              <button
                key={c}
                onClick={() => setQaCategory(c)}
                style={{ ...S.segmentBtn, ...(qaCategory === c ? S.segmentActive : {}) }}
              >
                {c === "staple" ? "Staple (2mo+)" : c === "fresh" ? "Fresh" : c === "spice" ? "Spice" : "Freezer"}
              </button>
            ))}
          </div>
          <div style={S.matchBtnRow}>
            <button style={S.confirmDeleteBtn} onClick={confirmQuickAdd}>
              Save to pantry
            </button>
            <button style={S.confirmCancelBtn} onClick={() => setShowQuickAdd(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {(freeIngredients.length > 0 || optionalFreeIngredients.length > 0) && (
        <div style={S.pickerList}>
          {freeIngredients.map((name, idx) => (
            <FreeIngredientRow
              key={`req:${idx}`}
              name={name}
              isOptional={false}
              amount={amountFor(`free:${name}`)}
              onNameChange={(newName) => onRenameFree(name, newName, false)}
              onQtyChange={(v) => setQty(`free:${name}`, v)}
              onUnitChange={(v) => setUnit(`free:${name}`, v)}
              onToggleOptional={() => onToggleFreeOptional(name, false)}
              onRemove={() => onRemoveFreeAny(name, false)}
              onTrack={(category) => onTrackFree(name, false, category)}
            />
          ))}
          {optionalFreeIngredients.map((name, idx) => (
            <FreeIngredientRow
              key={`opt:${idx}`}
              name={name}
              isOptional={true}
              amount={amountFor(`free:${name}`)}
              onNameChange={(newName) => onRenameFree(name, newName, true)}
              onQtyChange={(v) => setQty(`free:${name}`, v)}
              onUnitChange={(v) => setUnit(`free:${name}`, v)}
              onToggleOptional={() => onToggleFreeOptional(name, true)}
              onRemove={() => onRemoveFreeAny(name, true)}
              onTrack={(category) => onTrackFree(name, true, category)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function FreeIngredientRow({ name, isOptional, amount, onNameChange, onQtyChange, onUnitChange, onToggleOptional, onRemove, onTrack }) {
  const [showTrack, setShowTrack] = useState(false);
  const [category, setCategory] = useState("staple");

  if (showTrack) {
    return (
      <div style={S.freeIngredientRow}>
        <div style={S.listName}>Add "{name}" to your pantry (you'll set a date when you shop for it):</div>
        <div style={S.segment}>
          {["staple", "fresh", "spice", "freezer"].map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              style={{ ...S.segmentBtn, ...(category === c ? S.segmentActive : {}) }}
            >
              {c === "staple" ? "Staple (2mo+)" : c === "fresh" ? "Fresh" : c === "spice" ? "Spice" : "Freezer"}
            </button>
          ))}
        </div>
        <div style={S.matchBtnRow}>
          <button
            style={S.confirmDeleteBtn}
            onClick={() => {
              onTrack(category);
              setShowTrack(false);
            }}
          >
            Confirm
          </button>
          <button style={S.confirmCancelBtn} onClick={() => setShowTrack(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={S.freeIngredientRow}>
      <input style={S.qtyInput} value={amount.qty} onChange={(e) => onQtyChange(e.target.value)} placeholder="qty" />
      <input style={S.unitInput} value={amount.unit} onChange={(e) => onUnitChange(e.target.value)} placeholder="unit" />
      <input style={S.freeNameInput} value={name} onChange={(e) => onNameChange(e.target.value)} />
      <span
        style={{ ...S.optionalInlineToggle, ...(isOptional ? S.optionalInlineToggleActive : {}) }}
        onClick={onToggleOptional}
      >
        optional
      </span>
      <button style={S.chipRemove} onClick={onRemove}>
        ×
      </button>
      <button style={S.trackLinkBtn} onClick={() => setShowTrack(true)}>
        Track in pantry
      </button>
    </div>
  );
}

function ImportRecipeModal({ items, onClose, onImported }) {
  const [mode, setMode] = useState("photo");
  const [pastedText, setPastedText] = useState("");
  const [imageData, setImageData] = useState(null); // { base64, mediaType, previewUrl }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function handleFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
      if (!match) return;
      setImageData({ mediaType: match[1], base64: match[2], previewUrl: dataUrl });
    };
    reader.readAsDataURL(file);
  }

  async function handleExtract() {
    setLoading(true);
    setError("");
    try {
      const apiKey = getApiKey();
      if (!apiKey) {
        setError("Add your Anthropic API key in Settings first — this feature needs one to work.");
        setLoading(false);
        return;
      }

      const system = `Extract a recipe and respond with ONLY JSON, no prose, no markdown fences. Schema:
{"name": string, "yieldQty": number|null, "yieldLabel": string, "instructions": string, "ingredients": [{"name": string, "qty": string, "unit": string}]}
Split quantity and unit into separate fields (e.g. qty:"2", unit:"cups"), never combined. Keep ingredient names short and generic (e.g. "garlic cloves", not "3 large cloves garlic, minced") so they can be matched against a pantry list. Do not translate anything — keep the recipe name, ingredient names, and instructions in whatever language they appear in the source. In "instructions", put each step on its own line (separated by \\n), without numbering them yourself. Use null/"" for anything you can't determine — never invent values.`;

      const content =
        mode === "photo"
          ? [
              { type: "image", source: { type: "base64", media_type: imageData.mediaType, data: imageData.base64 } },
              { type: "text", text: "Extract this recipe." },
            ]
          : [{ type: "text", text: `Extract this recipe:\n\n${pastedText}` }];

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1200,
          system,
          messages: [{ role: "user", content }],
        }),
      });
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("Your API key was rejected — check it in Settings.");
        }
        throw new Error(`API request failed (${response.status})`);
      }
      const data = await response.json();
      const textBlock = (data.content || []).find((b) => b.type === "text");
      if (!textBlock) throw new Error("empty response");
      const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);

      const picked = [];
      const freeIngredients = [];
      const amounts = {};
      (parsed.ingredients || []).forEach((ing) => {
        if (!ing.name) return;
        const found = findSimilarItem(ing.name, items);
        const hasAmount = ing.qty || ing.unit;
        if (found) {
          picked.push(found.item.id);
          if (hasAmount) amounts[found.item.id] = { qty: ing.qty || "", unit: ing.unit || "" };
        } else {
          const displayName = capitalize(ing.name);
          freeIngredients.push(displayName);
          if (hasAmount) amounts[`free:${displayName}`] = { qty: ing.qty || "", unit: ing.unit || "" };
        }
      });

      onImported({
        name: parsed.name || "",
        picked,
        freeIngredients,
        amounts,
        yieldQty: parsed.yieldQty || null,
        yieldLabel: parsed.yieldLabel || "",
        instructions: parsed.instructions || "",
        source: mode === "photo" ? "photo" : "pasted text",
      });
    } catch (e) {
      if (e.message && (e.message.includes("API key") || e.message.includes("API request failed"))) {
        setError(e.message);
      } else {
        setError("Couldn't read that recipe — try a clearer photo, or enter it manually.");
      }
    } finally {
      setLoading(false);
    }
  }

  const canExtract = !loading && (mode === "photo" ? !!imageData : pastedText.trim().length > 10);

  return (
    <Modal onClose={onClose} title="Import recipe">
      <div style={S.segment}>
        <button
          onClick={() => setMode("photo")}
          style={{ ...S.segmentBtn, ...(mode === "photo" ? S.segmentActive : {}) }}
        >
          From photo
        </button>
        <button
          onClick={() => setMode("paste")}
          style={{ ...S.segmentBtn, ...(mode === "paste" ? S.segmentActive : {}) }}
        >
          Paste text
        </button>
      </div>

      {mode === "photo" ? (
        <>
          <label style={S.label}>Recipe photo</label>
          <input type="file" accept="image/*" onChange={handleFileChange} style={S.input} />
          {imageData && (
            <img src={imageData.previewUrl} alt="Recipe preview" style={S.importPreview} />
          )}
        </>
      ) : (
        <>
          <label style={S.label}>Paste recipe text</label>
          <textarea
            style={S.textarea}
            rows={8}
            value={pastedText}
            onChange={(e) => setPastedText(e.target.value)}
            placeholder="Paste ingredients and instructions here…"
          />
        </>
      )}

      {error && <div style={S.dupeWarning}>{error}</div>}

      <button
        style={{ ...S.primaryBtn, opacity: canExtract ? 1 : 0.4 }}
        disabled={!canExtract}
        onClick={handleExtract}
      >
        {loading ? "Reading recipe…" : "Extract recipe"}
      </button>
      <div style={S.pickerNote}>
        Uses Claude to read the recipe — you'll review and can edit everything before it's saved.
      </div>
    </Modal>
  );
}

function TagPicker({ tags, setTags }) {
  const [customInput, setCustomInput] = useState("");

  function toggle(tag) {
    setTags((t) => (t.includes(tag) ? t.filter((x) => x !== tag) : [...t, tag]));
  }

  function addCustom() {
    const t = capitalize(customInput.trim());
    if (!t || tags.includes(t)) {
      setCustomInput("");
      return;
    }
    setTags((prev) => [...prev, t]);
    setCustomInput("");
  }

  const customTags = tags.filter((t) => !RECIPE_TAG_PRESETS.includes(t));

  return (
    <>
      <label style={S.label}>Categories (optional)</label>
      <div style={S.segment}>
        {RECIPE_TAG_PRESETS.map((tag) => (
          <button
            key={tag}
            onClick={() => toggle(tag)}
            style={{ ...S.segmentBtn, ...(tags.includes(tag) ? S.segmentActive : {}) }}
          >
            {tag}
          </button>
        ))}
      </div>
      <div style={S.addRow}>
        <input
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addCustom()}
          placeholder="Add your own, e.g. Quick, Vegetarian"
          style={S.input}
        />
        <button style={S.smallBtn} onClick={addCustom}>
          Add
        </button>
      </div>
      {customTags.length > 0 && (
        <div style={S.chipRow}>
          {customTags.map((tag) => (
            <span key={tag} style={S.chip}>
              {tag}
              <button style={S.chipRemove} onClick={() => toggle(tag)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function AddRecipeModal({ items, recipes, onClose, onSave, onCreateItem, initial }) {
  const [name, setName] = useState(initial?.name || "");
  const [picked, setPicked] = useState(initial?.picked || []);
  const [optionalPicked, setOptionalPicked] = useState([]);
  const [freeIngredients, setFreeIngredients] = useState(initial?.freeIngredients || []);
  const [optionalFreeIngredients, setOptionalFreeIngredients] = useState([]);
  const [amounts, setAmounts] = useState(initial?.amounts || {});
  const [yieldQty, setYieldQty] = useState(initial?.yieldQty ? String(initial.yieldQty) : "");
  const [yieldLabel, setYieldLabel] = useState(initial?.yieldLabel || "");
  const [tags, setTags] = useState([]);
  const [instructions, setInstructions] = useState(initial?.instructions || "");

  function toggleInclude(id) {
    if (picked.includes(id)) {
      setPicked((p) => p.filter((x) => x !== id));
      return;
    }
    if (optionalPicked.includes(id)) {
      setOptionalPicked((p) => p.filter((x) => x !== id));
      return;
    }
    setPicked((p) => [...p, id]);
  }
  function toggleOptionalFlag(id) {
    if (picked.includes(id)) {
      setPicked((p) => p.filter((x) => x !== id));
      setOptionalPicked((p) => [...p, id]);
    } else if (optionalPicked.includes(id)) {
      setOptionalPicked((p) => p.filter((x) => x !== id));
      setPicked((p) => [...p, id]);
    }
  }
  function useExisting(id) {
    setPicked((p) => (p.includes(id) ? p : [...p, id]));
    setOptionalPicked((p) => p.filter((x) => x !== id));
  }
  function addFree(n) {
    setFreeIngredients((f) => [...f, n]);
  }
  function renameFree(oldName, newName, isOptional) {
    if (isOptional) setOptionalFreeIngredients((f) => f.map((n) => (n === oldName ? newName : n)));
    else setFreeIngredients((f) => f.map((n) => (n === oldName ? newName : n)));
    if (oldName === newName) return;
    setAmounts((a) => {
      const key = `free:${oldName}`;
      if (a[key] === undefined) return a;
      const { [key]: val, ...rest } = a;
      return { ...rest, [`free:${newName}`]: val };
    });
  }
  function toggleFreeOptional(name, isOptional) {
    if (isOptional) {
      setOptionalFreeIngredients((f) => f.filter((n) => n !== name));
      setFreeIngredients((f) => [...f, name]);
    } else {
      setFreeIngredients((f) => f.filter((n) => n !== name));
      setOptionalFreeIngredients((f) => [...f, name]);
    }
  }
  function removeFreeAny(name, isOptional) {
    if (isOptional) setOptionalFreeIngredients((f) => f.filter((n) => n !== name));
    else setFreeIngredients((f) => f.filter((n) => n !== name));
  }
  function trackFree(name, isOptional, category) {
    const newId = onCreateItem({
      name,
      category,
      expiryDate: "",
      shelfLifeDays: null,
      staleDate: "",
      available: false,
    });
    if (isOptional) {
      setOptionalFreeIngredients((f) => f.filter((n) => n !== name));
      setOptionalPicked((p) => (p.includes(newId) ? p : [...p, newId]));
    } else {
      setFreeIngredients((f) => f.filter((n) => n !== name));
      setPicked((p) => (p.includes(newId) ? p : [...p, newId]));
    }
    setAmounts((a) => {
      const key = `free:${name}`;
      if (a[key] === undefined) return a;
      const { [key]: val, ...rest } = a;
      return { ...rest, [newId]: val };
    });
  }

  const isExactDupe = isExactDuplicate(name, recipes);
  const canSave =
    name.trim() &&
    !isExactDupe &&
    (picked.length > 0 || freeIngredients.length > 0 || optionalPicked.length > 0 || optionalFreeIngredients.length > 0);

  return (
    <Modal onClose={onClose} title={initial ? "Review imported recipe" : "Add recipe"}>
      {initial && (
        <div style={S.pickerNote}>
          Pulled from your {initial.source || "import"} — double-check names, amounts, and matches before saving.
        </div>
      )}
      <label style={S.label}>Recipe name</label>
      <input
        autoFocus
        style={S.input}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Rice and beans"
      />
      {isExactDupe && (
        <div style={S.dupeWarning}>
          You already have a recipe named "{name.trim()}". Edit that one instead, or use a different name.
        </div>
      )}

      <label style={S.label}>Yield (optional)</label>
      <div style={S.addRow}>
        <input
          type="number"
          min="1"
          style={S.qtyInput}
          value={yieldQty}
          onChange={(e) => setYieldQty(e.target.value)}
          placeholder="4"
        />
        <input
          style={S.input}
          value={yieldLabel}
          onChange={(e) => setYieldLabel(e.target.value)}
          placeholder="e.g. servings, cookies, loaves"
        />
      </div>

      <TagPicker tags={tags} setTags={setTags} />

      <IngredientPicker
        items={items}
        picked={picked}
        onToggleInclude={toggleInclude}
        optionalPicked={optionalPicked}
        onToggleOptionalFlag={toggleOptionalFlag}
        onUseExisting={useExisting}
        onCreateItem={onCreateItem}
        freeIngredients={freeIngredients}
        optionalFreeIngredients={optionalFreeIngredients}
        onAddFree={addFree}
        onRenameFree={renameFree}
        onToggleFreeOptional={toggleFreeOptional}
        onRemoveFreeAny={removeFreeAny}
        onTrackFree={trackFree}
        amounts={amounts}
        setAmounts={setAmounts}
      />

      <label style={S.label}>Instructions (optional)</label>
      <textarea
        style={S.textarea}
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        placeholder="One step per line, e.g.:
Rinse the rice
Simmer 18 minutes
Stir in beans"
        rows={4}
      />

      <button
        style={{ ...S.primaryBtn, opacity: canSave ? 1 : 0.4 }}
        disabled={!canSave}
        onClick={() =>
          onSave({
            name,
            ingredientIds: picked,
            optionalIngredientIds: optionalPicked,
            freeIngredients,
            optionalFreeIngredients,
            amounts,
            yieldQty: yieldQty ? Number(yieldQty) : null,
            yieldLabel,
            tags,
            instructions,
          })
        }
      >
        Save recipe
      </button>
    </Modal>
  );
}

function RecipeViewModal({ recipe, items, shoppingList, onClose, onEdit, onAddMissing, onAddOptional }) {
  const status = recipeStatus(recipe, items);
  const {
    ready,
    resolved,
    freeIngredients,
    optionalResolved,
    optionalMissing,
    optionalFreeIngredients,
    effectiveIngredientIds,
    effectiveOptionalIngredientIds,
    displayAmounts,
  } = status;
  const [showOptionalPrompt, setShowOptionalPrompt] = useState(false);
  const [scaleTo, setScaleTo] = useState(recipe.yieldQty ? String(recipe.yieldQty) : "");
  const hasMissingOptional = optionalMissing.length > 0;
  const covered = missingCoverage(status, shoppingList);
  const statusColor = ready ? "#4C6B4F" : covered ? "#B5824A" : "#B5482F";
  const amounts = displayAmounts;

  const scaleFactor =
    recipe.yieldQty && scaleTo && Number(scaleTo) > 0 ? Number(scaleTo) / recipe.yieldQty : 1;

  function scaledDisplay(amount) {
    const a = displayAmount(amount);
    if (!a || scaleFactor === 1) return a;
    if (typeof amount === "object" && amount.qty) {
      return [scaleQty(amount.qty, scaleFactor), amount.unit].filter(Boolean).join(" ");
    }
    return a; // freeform string amounts can't be scaled
  }

  const requiredList = [
    ...resolved.map((item, idx) => ({
      key: effectiveIngredientIds[idx],
      name: item ? item.name : "(removed)",
      amount: amounts[effectiveIngredientIds[idx]],
    })),
    ...freeIngredients.map((name) => ({ key: `free:${name}`, name, amount: amounts[`free:${name}`] })),
  ];
  const optionalList = [
    ...optionalResolved.map((item, idx) => ({
      key: effectiveOptionalIngredientIds[idx],
      name: item ? item.name : "(removed)",
      amount: amounts[effectiveOptionalIngredientIds[idx]],
    })),
    ...optionalFreeIngredients.map((name) => ({ key: `free:${name}`, name, amount: amounts[`free:${name}`] })),
  ];

  function handleAddMissingClick() {
    onAddMissing(recipe);
    if (hasMissingOptional) setShowOptionalPrompt(true);
  }

  function confirmAddOptional() {
    onAddOptional(recipe);
    setShowOptionalPrompt(false);
  }

  return (
    <Modal onClose={onClose} title={recipe.name}>
      <div style={{ ...S.matchText, color: statusColor, fontWeight: 500 }}>
        {ready ? "Ready to cook" : covered ? "Missing something — but it's already on your list" : "Missing something"}
      </div>

      {recipe.tags && recipe.tags.length > 0 && (
        <div style={S.chipRow}>
          {recipe.tags.map((tag) => (
            <span key={tag} style={S.tagAuto}>
              {tag}
            </span>
          ))}
        </div>
      )}

      {recipe.yieldQty ? (
        <div style={S.yieldRow}>
          <span style={S.pickerNote}>
            Makes {recipe.yieldQty} {recipe.yieldLabel || ""} — scale to:
          </span>
          <input
            type="number"
            min="1"
            style={S.qtyInput}
            value={scaleTo}
            onChange={(e) => setScaleTo(e.target.value)}
          />
        </div>
      ) : recipe.yieldLabel ? (
        <div style={S.pickerNote}>Makes {recipe.yieldLabel}</div>
      ) : null}

      <label style={S.label}>Ingredients</label>
      <ul style={S.list}>
        {requiredList.map((ref) => (
          <li key={ref.key} style={S.listRow}>
            <span style={S.listName}>{ref.name}</span>
            {ref.amount && <span style={S.amountBadge}>{scaledDisplay(ref.amount)}</span>}
          </li>
        ))}
      </ul>

      {optionalList.length > 0 && (
        <>
          <label style={S.label}>Optional</label>
          <ul style={S.list}>
            {optionalList.map((ref) => (
              <li key={ref.key} style={S.listRow}>
                <span style={S.listName}>{ref.name}</span>
                {ref.amount && <span style={S.amountBadge}>{scaledDisplay(ref.amount)}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {recipe.instructions && (
        <>
          <label style={S.label}>Instructions</label>
          <ol style={S.stepsList}>
            {stepsFromText(recipe.instructions).map((step, i) => (
              <li key={i} style={S.stepItem}>
                <span style={S.stepNumber}>{i + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </>
      )}

      {((!ready && !covered) || hasMissingOptional) && (
        <button style={S.addMissingBtn} onClick={handleAddMissingClick}>
          Add missing ingredients to list
        </button>
      )}

      {showOptionalPrompt && (
        <div style={S.matchBanner}>
          <div style={S.matchText}>
            Also add optional ingredients: {optionalMissing.map((i) => (i ? i.name : "(removed)")).join(", ")}?
          </div>
          <div style={S.matchBtnRow}>
            <button style={S.confirmDeleteBtn} onClick={confirmAddOptional}>
              Yes, add them
            </button>
            <button style={S.confirmCancelBtn} onClick={() => setShowOptionalPrompt(false)}>
              No thanks
            </button>
          </div>
        </div>
      )}

      <button style={{ ...S.primaryBtn, marginTop: "16px" }} onClick={onEdit}>
        Edit recipe
      </button>
    </Modal>
  );
}

function RecipeEditModal({ recipe, items, recipes, onClose, onSave, onDelete, onCreateItem }) {
  const reconciled = reconcileFreeIngredients(
    recipe.ingredientIds,
    recipe.freeIngredients || [],
    recipe.amounts || {},
    items
  );
  const optReconciled = reconcileFreeIngredients(
    recipe.optionalIngredientIds || [],
    recipe.optionalFreeIngredients || [],
    reconciled.amounts,
    items
  );
  const [name, setName] = useState(recipe.name);
  const [picked, setPicked] = useState(reconciled.ingredientIds);
  const [optionalPicked, setOptionalPicked] = useState(optReconciled.ingredientIds);
  const [freeIngredients, setFreeIngredients] = useState(reconciled.freeIngredients);
  const [optionalFreeIngredients, setOptionalFreeIngredients] = useState(optReconciled.freeIngredients);
  const [amounts, setAmounts] = useState(optReconciled.amounts);
  const [yieldQty, setYieldQty] = useState(recipe.yieldQty ? String(recipe.yieldQty) : "");
  const [yieldLabel, setYieldLabel] = useState(recipe.yieldLabel || "");
  const [tags, setTags] = useState(recipe.tags || []);
  const [instructions, setInstructions] = useState(recipe.instructions || "");
  const [confirmDelete, setConfirmDelete] = useState(false);

  function toggleInclude(id) {
    if (picked.includes(id)) {
      setPicked((p) => p.filter((x) => x !== id));
      return;
    }
    if (optionalPicked.includes(id)) {
      setOptionalPicked((p) => p.filter((x) => x !== id));
      return;
    }
    setPicked((p) => [...p, id]);
  }
  function toggleOptionalFlag(id) {
    if (picked.includes(id)) {
      setPicked((p) => p.filter((x) => x !== id));
      setOptionalPicked((p) => [...p, id]);
    } else if (optionalPicked.includes(id)) {
      setOptionalPicked((p) => p.filter((x) => x !== id));
      setPicked((p) => [...p, id]);
    }
  }
  function useExisting(id) {
    setPicked((p) => (p.includes(id) ? p : [...p, id]));
    setOptionalPicked((p) => p.filter((x) => x !== id));
  }
  function addFree(n) {
    setFreeIngredients((f) => [...f, n]);
  }
  function renameFree(oldName, newName, isOptional) {
    if (isOptional) setOptionalFreeIngredients((f) => f.map((n) => (n === oldName ? newName : n)));
    else setFreeIngredients((f) => f.map((n) => (n === oldName ? newName : n)));
    if (oldName === newName) return;
    setAmounts((a) => {
      const key = `free:${oldName}`;
      if (a[key] === undefined) return a;
      const { [key]: val, ...rest } = a;
      return { ...rest, [`free:${newName}`]: val };
    });
  }
  function toggleFreeOptional(name, isOptional) {
    if (isOptional) {
      setOptionalFreeIngredients((f) => f.filter((n) => n !== name));
      setFreeIngredients((f) => [...f, name]);
    } else {
      setFreeIngredients((f) => f.filter((n) => n !== name));
      setOptionalFreeIngredients((f) => [...f, name]);
    }
  }
  function removeFreeAny(name, isOptional) {
    if (isOptional) setOptionalFreeIngredients((f) => f.filter((n) => n !== name));
    else setFreeIngredients((f) => f.filter((n) => n !== name));
  }
  function trackFree(name, isOptional, category) {
    const newId = onCreateItem({
      name,
      category,
      expiryDate: "",
      shelfLifeDays: null,
      staleDate: "",
      available: false,
    });
    if (isOptional) {
      setOptionalFreeIngredients((f) => f.filter((n) => n !== name));
      setOptionalPicked((p) => (p.includes(newId) ? p : [...p, newId]));
    } else {
      setFreeIngredients((f) => f.filter((n) => n !== name));
      setPicked((p) => (p.includes(newId) ? p : [...p, newId]));
    }
    setAmounts((a) => {
      const key = `free:${name}`;
      if (a[key] === undefined) return a;
      const { [key]: val, ...rest } = a;
      return { ...rest, [newId]: val };
    });
  }

  const isExactDupe = isExactDuplicate(name, recipes, recipe.id);
  const canSave =
    name.trim() &&
    !isExactDupe &&
    (picked.length > 0 || freeIngredients.length > 0 || optionalPicked.length > 0 || optionalFreeIngredients.length > 0);

  return (
    <Modal onClose={onClose} title="Edit recipe">
      <label style={S.label}>Recipe name</label>
      <input style={S.input} value={name} onChange={(e) => setName(e.target.value)} />
      {isExactDupe && (
        <div style={S.dupeWarning}>
          You already have a recipe named "{name.trim()}". Edit that one instead, or use a different name.
        </div>
      )}

      <label style={S.label}>Yield (optional)</label>
      <div style={S.addRow}>
        <input
          type="number"
          min="1"
          style={S.qtyInput}
          value={yieldQty}
          onChange={(e) => setYieldQty(e.target.value)}
          placeholder="4"
        />
        <input
          style={S.input}
          value={yieldLabel}
          onChange={(e) => setYieldLabel(e.target.value)}
          placeholder="e.g. servings, cookies, loaves"
        />
      </div>

      <TagPicker tags={tags} setTags={setTags} />

      <IngredientPicker
        items={items}
        picked={picked}
        onToggleInclude={toggleInclude}
        optionalPicked={optionalPicked}
        onToggleOptionalFlag={toggleOptionalFlag}
        onUseExisting={useExisting}
        onCreateItem={onCreateItem}
        freeIngredients={freeIngredients}
        optionalFreeIngredients={optionalFreeIngredients}
        onAddFree={addFree}
        onRenameFree={renameFree}
        onToggleFreeOptional={toggleFreeOptional}
        onRemoveFreeAny={removeFreeAny}
        onTrackFree={trackFree}
        amounts={amounts}
        setAmounts={setAmounts}
      />

      <label style={S.label}>Instructions (optional)</label>
      <textarea
        style={S.textarea}
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        placeholder="One step per line, e.g.:
Rinse the rice
Simmer 18 minutes
Stir in beans"
        rows={4}
      />

      <button
        style={{ ...S.primaryBtn, opacity: canSave ? 1 : 0.4 }}
        disabled={!canSave}
        onClick={() =>
          onSave({
            name,
            ingredientIds: picked,
            optionalIngredientIds: optionalPicked,
            freeIngredients,
            optionalFreeIngredients,
            amounts,
            yieldQty: yieldQty ? Number(yieldQty) : null,
            yieldLabel,
            tags,
            instructions,
          })
        }
      >
        Save changes
      </button>

      {confirmDelete ? (
        <div style={S.confirmRow}>
          <span style={S.confirmText}>Delete this recipe?</span>
          <button style={S.confirmDeleteBtn} onClick={onDelete}>
            Yes, delete
          </button>
          <button style={S.confirmCancelBtn} onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button style={S.deleteBtn} onClick={() => setConfirmDelete(true)}>
          Delete recipe
        </button>
      )}
    </Modal>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={S.modalHead}>
          <span style={S.modalTitle}>{title}</span>
          <button style={S.removeBtn} onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------------- small bits ----------------

function SectionHead({ title, sub, accent }) {
  return (
    <div style={S.sectionHead}>
      <span style={{ ...S.sectionDot, background: accent }} />
      <span style={S.sectionTitle}>{title}</span>
      {sub && <span style={S.sectionSub}>{sub}</span>}
    </div>
  );
}

function EmptyRow({ text }) {
  return <div style={S.empty}>{text}</div>;
}

function FontImport() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=IBM+Plex+Sans:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap');
      * { box-sizing: border-box; }
      button { font-family: inherit; cursor: pointer; border: none; }
      input { font-family: inherit; }
    `}</style>
  );
}

// ---------------- style tokens ----------------

const FONT = {
  display: "'Fraunces', serif",
  body: "'IBM Plex Sans', sans-serif",
  mono: "'IBM Plex Mono', monospace",
};

const S = {
  app: {
    minHeight: "100vh",
    background: "#EDE6D6",
    color: "#2B2A25",
    fontFamily: FONT.body,
    paddingTop: "env(safe-area-inset-top)",
    paddingBottom: "calc(80px + env(safe-area-inset-bottom))",
  },
  header: {
    padding: "28px 20px 12px",
    borderBottom: "1px solid #C9BFA8",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  settingsBtn: {
    background: "transparent",
    border: "1px solid #C9BFA8",
    borderRadius: "50%",
    width: "36px",
    height: "36px",
    fontSize: "16px",
    color: "#8A7F68",
  },
  eyebrow: {
    fontFamily: FONT.mono,
    fontSize: "11px",
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: "#8A6D3B",
    marginBottom: "4px",
  },
  h1: {
    fontFamily: FONT.display,
    fontWeight: 600,
    fontSize: "28px",
    margin: 0,
  },
  tabs: {
    display: "flex",
    gap: "4px",
    padding: "12px 16px 0",
  },
  tab: {
    flex: 1,
    background: "transparent",
    padding: "10px 8px",
    fontSize: "13px",
    fontFamily: FONT.body,
    color: "#8A7F68",
    borderBottom: "2px solid transparent",
  },
  tabActive: {
    color: "#2B2A25",
    borderBottom: "2px solid #8A6D3B",
    fontWeight: 500,
  },
  main: {
    padding: "16px",
  },
  sectionHead: {
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
    margin: "20px 0 10px",
  },
  sectionDot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    display: "inline-block",
  },
  sectionTitle: {
    fontFamily: FONT.display,
    fontWeight: 600,
    fontSize: "17px",
  },
  sectionSub: {
    fontFamily: FONT.mono,
    fontSize: "11px",
    color: "#8A7F68",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "10px",
  },
  card: {
    background: "#E2D9C4",
    border: "1px solid #C9BFA8",
    borderRadius: "10px",
    padding: "12px",
  },
  cardUnavailable: {
    borderColor: "#8A7F68",
    opacity: 0.7,
  },
  cardTitleRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "6px",
  },
  cardTitle: {
    fontFamily: FONT.body,
    fontWeight: 500,
    fontSize: "14px",
    lineHeight: 1.3,
  },
  cardMeta: {
    fontFamily: FONT.mono,
    fontSize: "11px",
    marginTop: "6px",
  },
  decayTrack: {
    height: "4px",
    background: "#C9BFA8",
    borderRadius: "2px",
    marginTop: "10px",
    overflow: "hidden",
  },
  decayFill: {
    height: "100%",
    transition: "width 0.3s ease",
  },
  chipRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    marginBottom: "10px",
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    background: "#EDE6D6",
    border: "1px solid #C9BFA8",
    borderRadius: "12px",
    padding: "4px 6px 4px 10px",
    fontSize: "12px",
  },
  chipRemove: {
    background: "transparent",
    color: "#8A7F68",
    fontSize: "14px",
    lineHeight: 1,
    padding: "0 4px",
  },
  suggestDropdown: {
    background: "#F5F0E4",
    border: "1px solid #C9BFA8",
    borderRadius: "8px",
    marginTop: "-6px",
    marginBottom: "10px",
    overflow: "hidden",
  },
  suggestItem: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    width: "100%",
    background: "transparent",
    border: "none",
    borderBottom: "1px solid #C9BFA8",
    padding: "10px 12px",
    fontSize: "13px",
    color: "#2B2A25",
    textAlign: "left",
  },
  suggestMeta: {
    fontFamily: FONT.mono,
    fontSize: "10px",
    color: "#8A7F68",
  },
  matchBanner: {
    background: "#F5F0E4",
    border: "1px solid #8A6D3B",
    borderRadius: "8px",
    padding: "10px 12px",
    marginBottom: "10px",
  },
  matchBannerWarn: {
    background: "#F5F0E4",
    border: "1px solid #B5482F",
    borderRadius: "8px",
    padding: "10px 12px",
    marginBottom: "10px",
  },
  matchText: {
    fontSize: "12px",
    color: "#2B2A25",
    marginBottom: "8px",
  },
  matchBtnRow: {
    display: "flex",
    gap: "8px",
  },
  sectionHeadRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
  },
  segmentSmall: {
    display: "flex",
    gap: "4px",
    background: "#E2D9C4",
    borderRadius: "8px",
    padding: "2px",
  },
  segmentSmallBtn: {
    background: "transparent",
    padding: "5px 10px",
    fontSize: "11px",
    borderRadius: "6px",
    color: "#8A7F68",
    fontFamily: FONT.mono,
  },
  segmentSmallActive: {
    background: "#2B2A25",
    color: "#EDE6D6",
  },
  tagFilterRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    marginBottom: "12px",
  },
  tagFilterChip: {
    background: "transparent",
    color: "#8A7F68",
    border: "1px solid #C9BFA8",
    borderRadius: "12px",
    padding: "4px 10px",
    fontSize: "11px",
    fontFamily: FONT.mono,
  },
  tagFilterChipActive: {
    background: "#8A6D3B",
    color: "#EDE6D6",
    borderColor: "#8A6D3B",
  },
  deleteBtn: {
    width: "100%",
    background: "transparent",
    color: "#B5482F",
    border: "1px solid #B5482F",
    borderRadius: "8px",
    padding: "10px",
    fontSize: "13px",
    marginTop: "12px",
  },
  confirmRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginTop: "12px",
    flexWrap: "wrap",
  },
  confirmText: {
    fontSize: "12px",
    color: "#8A7F68",
    flexBasis: "100%",
  },
  confirmDeleteBtn: {
    background: "#B5482F",
    color: "#EDE6D6",
    borderRadius: "6px",
    padding: "8px 14px",
    fontSize: "12px",
  },
  confirmCancelBtn: {
    background: "transparent",
    color: "#8A7F68",
    border: "1px solid #C9BFA8",
    borderRadius: "6px",
    padding: "8px 14px",
    fontSize: "12px",
  },
  shelfLifeNote: {
    fontSize: "10px",
    color: "#8A6D3B",
    fontFamily: FONT.mono,
    marginTop: "4px",
  },
  restockForm: {
    marginTop: "8px",
    paddingTop: "8px",
    borderTop: "1px dashed #C9BFA8",
  },
  cardBtnRow: {
    display: "flex",
    gap: "6px",
    marginTop: "10px",
  },
  lowBtn: {
    marginTop: "10px",
    width: "100%",
    background: "#EDE6D6",
    border: "1px solid #C9BFA8",
    borderRadius: "6px",
    padding: "7px",
    fontSize: "12px",
    color: "#2B2A25",
  },
  lowBtnActive: {
    background: "#8A6D3B",
    borderColor: "#8A6D3B",
    color: "#EDE6D6",
  },
  fab: {
    position: "fixed",
    bottom: "calc(24px + env(safe-area-inset-bottom))",
    right: "24px",
    width: "52px",
    height: "52px",
    borderRadius: "50%",
    background: "#2B2A25",
    color: "#EDE6D6",
    fontSize: "26px",
    lineHeight: "52px",
    textAlign: "center",
    boxShadow: "0 4px 14px rgba(43,42,37,0.35)",
  },
  settingsFab: {
    position: "fixed",
    bottom: "calc(24px + env(safe-area-inset-bottom))",
    left: "24px",
    width: "48px",
    height: "48px",
    borderRadius: "50%",
    background: "#EDE6D6",
    border: "1px solid #C9BFA8",
    color: "#8A7F68",
    fontSize: "20px",
    lineHeight: "46px",
    textAlign: "center",
    boxShadow: "0 4px 14px rgba(43,42,37,0.2)",
  },
  empty: {
    fontFamily: FONT.body,
    fontSize: "13px",
    color: "#8A7F68",
    padding: "16px",
    border: "1px dashed #C9BFA8",
    borderRadius: "10px",
  },
  addRow: {
    display: "flex",
    gap: "8px",
    marginBottom: "8px",
  },
  input: {
    width: "100%",
    background: "#F5F0E4",
    border: "1px solid #C9BFA8",
    borderRadius: "8px",
    padding: "10px 12px",
    fontSize: "14px",
    color: "#2B2A25",
  },
  daysLabel: {
    fontSize: "12px",
    color: "#8A7F68",
    whiteSpace: "nowrap",
    alignSelf: "center",
  },
  suggestBtn: {
    background: "transparent",
    color: "#8A6D3B",
    border: "1px dashed #8A6D3B",
    borderRadius: "6px",
    padding: "5px 10px",
    fontSize: "11px",
    marginBottom: "8px",
  },
  smallBtn: {
    background: "#2B2A25",
    color: "#EDE6D6",
    borderRadius: "8px",
    padding: "0 16px",
    fontSize: "13px",
  },
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
  },
  listRow: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 4px",
    borderBottom: "1px solid #C9BFA8",
  },
  checkbox: {
    width: "18px",
    height: "18px",
    borderRadius: "50%",
    border: "1.5px solid #8A6D3B",
    background: "transparent",
    flexShrink: 0,
  },
  importLink: {
    background: "transparent",
    color: "#8A6D3B",
    border: "1px dashed #8A6D3B",
    borderRadius: "8px",
    padding: "8px 12px",
    fontSize: "12px",
    marginBottom: "12px",
    width: "100%",
  },
  resetListBtn: {
    background: "transparent",
    color: "#8A7F68",
    border: "1px solid #C9BFA8",
    borderRadius: "6px",
    padding: "4px 10px",
    fontSize: "11px",
    fontFamily: FONT.mono,
  },
  restockChip: {
    width: "22px",
    height: "22px",
    borderRadius: "50%",
    border: "1.5px solid #4C6B4F",
    color: "#4C6B4F",
    background: "transparent",
    flexShrink: 0,
    fontSize: "13px",
    lineHeight: "18px",
    padding: 0,
  },
  usedUpSection: {
    marginTop: "10px",
    marginBottom: "4px",
  },
  collapsibleHeader: {
    background: "transparent",
    color: "#8A7F68",
    fontFamily: FONT.mono,
    fontSize: "12px",
    padding: "6px 2px",
    marginBottom: "4px",
  },
  restockRow: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    padding: "10px 4px",
    borderBottom: "1px solid #C9BFA8",
    gap: "4px",
  },
  listName: {
    flex: 1,
    fontSize: "14px",
  },
  tagAuto: {
    fontFamily: FONT.mono,
    fontSize: "10px",
    color: "#8A6D3B",
    background: "#EDE6D6",
    border: "1px solid #C9BFA8",
    borderRadius: "10px",
    padding: "2px 8px",
  },
  removeBtn: {
    background: "transparent",
    color: "#8A7F68",
    fontSize: "18px",
    lineHeight: 1,
    padding: "2px 6px",
  },
  editBtn: {
    background: "transparent",
    color: "#8A7F68",
    fontSize: "13px",
    lineHeight: 1,
    padding: "2px 6px",
  },
  instructions: {
    fontSize: "12px",
    color: "#5C5847",
    marginTop: "8px",
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
  },
  stepsList: {
    listStyle: "none",
    margin: 0,
    padding: 0,
  },
  stepItem: {
    display: "flex",
    gap: "10px",
    padding: "8px 0",
    borderBottom: "1px solid #C9BFA8",
    fontSize: "13px",
    lineHeight: 1.5,
  },
  stepNumber: {
    fontFamily: FONT.mono,
    fontSize: "12px",
    color: "#8A6D3B",
    flexShrink: 0,
    minWidth: "18px",
  },
  optionalNote: {
    fontSize: "12px",
    color: "#8A7F68",
    fontStyle: "italic",
    marginTop: "4px",
  },
  untrackedNote: {
    color: "#8A7F68",
  },
  ingredientList: {
    fontFamily: FONT.mono,
    fontSize: "11px",
    color: "#8A7F68",
    marginTop: "8px",
  },
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(43,42,37,0.45)",
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    zIndex: 50,
  },
  modal: {
    background: "#EDE6D6",
    width: "100%",
    maxWidth: "480px",
    borderRadius: "16px 16px 0 0",
    padding: "20px",
    maxHeight: "85vh",
    overflowY: "auto",
  },
  modalHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "16px",
  },
  modalTitle: {
    fontFamily: FONT.display,
    fontWeight: 600,
    fontSize: "18px",
  },
  label: {
    display: "block",
    fontFamily: FONT.mono,
    fontSize: "11px",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "#8A7F68",
    margin: "14px 0 6px",
  },
  segment: {
    display: "flex",
    gap: "8px",
  },
  segmentBtn: {
    flex: 1,
    background: "#F5F0E4",
    border: "1px solid #C9BFA8",
    borderRadius: "8px",
    padding: "10px",
    fontSize: "13px",
  },
  segmentActive: {
    background: "#2B2A25",
    color: "#EDE6D6",
    borderColor: "#2B2A25",
  },
  primaryBtn: {
    width: "100%",
    background: "#8A6D3B",
    color: "#EDE6D6",
    borderRadius: "8px",
    padding: "12px",
    fontSize: "14px",
    fontWeight: 500,
    marginTop: "20px",
  },
  textarea: {
    width: "100%",
    background: "#F5F0E4",
    border: "1px solid #C9BFA8",
    borderRadius: "8px",
    padding: "10px 12px",
    fontSize: "13px",
    color: "#2B2A25",
    fontFamily: FONT.body,
    resize: "vertical",
  },
  pickerList: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    maxHeight: "140px",
    overflowY: "auto",
    marginBottom: "10px",
  },
  pickerGroupLabel: {
    fontFamily: FONT.mono,
    fontSize: "10px",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "#8A7F68",
    marginBottom: "4px",
  },
  pickerNote: {
    fontSize: "12px",
    color: "#8A7F68",
    marginBottom: "10px",
  },
  addMissingBtn: {
    marginTop: "10px",
    width: "100%",
    background: "#B5482F",
    color: "#EDE6D6",
    border: "none",
    borderRadius: "6px",
    padding: "7px",
    fontSize: "12px",
  },
  statusDot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    flexShrink: 0,
    marginTop: "4px",
  },
  pickerRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "13px",
  },
  optionalInlineToggle: {
    fontSize: "10px",
    fontFamily: FONT.mono,
    color: "#8A7F68",
    border: "1px solid #C9BFA8",
    borderRadius: "10px",
    padding: "2px 8px",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  optionalInlineToggleActive: {
    color: "#8A6D3B",
    borderColor: "#8A6D3B",
    background: "#F5F0E4",
  },
  amountRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  amountLabel: {
    flex: 1,
    fontSize: "13px",
  },
  amountInput: {
    width: "110px",
    background: "#F5F0E4",
    border: "1px solid #C9BFA8",
    borderRadius: "6px",
    padding: "6px 8px",
    fontSize: "12px",
    color: "#2B2A25",
  },
  qtyInput: {
    width: "44px",
    background: "#F5F0E4",
    border: "1px solid #C9BFA8",
    borderRadius: "6px",
    padding: "4px 6px",
    fontSize: "12px",
    color: "#2B2A25",
  },
  unitInput: {
    width: "56px",
    background: "#F5F0E4",
    border: "1px solid #C9BFA8",
    borderRadius: "6px",
    padding: "4px 6px",
    fontSize: "12px",
    color: "#2B2A25",
  },
  freeAmountRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  freeIngredientRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px",
    padding: "8px 0",
    borderBottom: "1px solid #C9BFA8",
  },
  freeNameInput: {
    flex: 1,
    minWidth: "90px",
    background: "#F5F0E4",
    border: "1px solid #C9BFA8",
    borderRadius: "6px",
    padding: "6px 8px",
    fontSize: "13px",
    color: "#2B2A25",
  },
  trackLinkBtn: {
    background: "transparent",
    color: "#4C6B4F",
    border: "1px dashed #4C6B4F",
    borderRadius: "6px",
    padding: "4px 8px",
    fontSize: "11px",
    width: "100%",
  },
  importPreview: {
    width: "100%",
    maxHeight: "220px",
    objectFit: "contain",
    borderRadius: "8px",
    border: "1px solid #C9BFA8",
    marginTop: "8px",
    marginBottom: "8px",
  },
  dupeWarning: {
    fontSize: "12px",
    color: "#B5482F",
    marginTop: "-4px",
    marginBottom: "8px",
  },
  yieldRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "8px",
  },
  amountBadge: {
    fontFamily: FONT.mono,
    fontSize: "11px",
    color: "#8A7F68",
  },
  errorBanner: {
    background: "#B5482F",
    color: "#EDE6D6",
    fontSize: "12px",
    padding: "8px 16px",
    fontFamily: FONT.mono,
  },
};
