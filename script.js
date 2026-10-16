import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  collection,
  deleteDoc,
  doc,
  getFirestore,
  onSnapshot,
  runTransaction,
  setDoc,
  updateDoc
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

(() => {
  'use strict';

  // Substitua estes valores pelos dados do seu projeto em Firebase Console > Configurações do projeto.
  const firebaseConfig = {
    apiKey: 'AIzaSyB8bllF_Dtv8m5KQWE1UB0CUpMrBm6tgpw',
    authDomain: 'ceni-sistema-91fc0.firebaseapp.com',
    projectId: 'ceni-sistema-91fc0',
    storageBucket: 'ceni-sistema-91fc0.firebasestorage.app',
    messagingSenderId: '37904088103',
    appId: '1:37904088103:web:71850292e75661cda7e202'
  };
  const COLLECTIONS = ['produtos', 'servicos', 'promocoes', 'vendas', 'financas'];
  const DEFAULT_ATTENDANTS = ['Caixa 1', 'Caixa 2', 'Caixa 3'];
  const SECTOR_TAGS = {
    Distribuidora: ['Cerveja', 'Refrigerante', 'Vodka', 'Whisky', 'Vinho', 'Churrasco'],
    Tabacaria: ['Seda', 'Essências', 'Carvão', 'Cigarro', 'Fumo', 'Narguile'],
    Conveniência: ['Salgadinhos', 'Doces', 'Gelo', 'Outros']
  };
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const currency = value => Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const dateOnly = date => {
    const d = new Date(date);
    return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const formatDate = date => date ? new Date(`${date}T12:00:00`).toLocaleDateString('pt-BR') : 'Sem validade';
  const escapeHtml = value => String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const makeNumber = () => String(Date.now()).slice(-6);

  const state = { products: [], services: [], promotions: [], sales: [], finances: [], attendants: DEFAULT_ATTENDANTS.slice() };
  let cart = [];
  let db = null;
  let cloudReady = false;
  let snapshotCount = 0;
  let lastCloudError = '';

  function notify(message, isError = false) {
    const region = $('#toastRegion');
    if (!region) return;
    const toast = document.createElement('div');
    toast.className = `toast${isError ? ' error' : ''}`;
    toast.textContent = message;
    region.append(toast);
    window.setTimeout(() => toast.remove(), 4200);
  }

  function firebaseConfigured() {
    return firebaseConfig.apiKey !== 'COLOQUE_SUA_API_KEY'
      && firebaseConfig.projectId !== 'SEU_PROJECT_ID'
      && firebaseConfig.messagingSenderId !== 'SEU_MESSAGING_SENDER_ID'
      && firebaseConfig.appId !== 'SEU_APP_ID';
  }

  function setConnectionStatus(status, message) {
    $('#connectionStatus').textContent = message;
    $('#connectionDot').classList.toggle('connection-error', status === 'error');
    $('#connectionDot').classList.toggle('connection-live', status === 'live');
  }

  function ensureCloud() {
    if (!db || !cloudReady) throw new Error('O Firestore ainda não está conectado. Confira a configuração Firebase e tente novamente.');
  }

  function reportCloudError(error) {
    console.error('Erro na comunicação com o Firebase Firestore.', error);
    const message = error && error.code === 'permission-denied'
      ? 'Acesso negado pelo Firestore. Confira as regras de segurança do projeto.'
      : error && error.message
        ? `Falha no Firebase: ${error.message}`
        : 'Não foi possível concluir a operação na nuvem.';
    notify(message, true);
  }

  async function runCloudAction(action, successMessage) {
    try {
      ensureCloud();
      await action();
      if (successMessage) notify(successMessage);
    } catch (error) {
      if (error && error.code) reportCloudError(error);
      else notify(error && error.message ? error.message : 'Não foi possível concluir a operação.', true);
    }
  }

  function dateTime(date = new Date()) {
    const value = date instanceof Date ? date : new Date(date);
    return Number.isNaN(value.getTime()) ? '—' : value.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  }

  function monthKey(value) {
    const date = new Date(value);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function isCurrentMonth(value) {
    return monthKey(value) === monthKey(new Date());
  }

  function expiryState(expiry) {
    if (!expiry) return { status: '', text: '—' };
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const date = new Date(`${expiry}T00:00:00`);
    if (Number.isNaN(date.getTime())) return { status: '', text: '—' };
    const days = Math.ceil((date - today) / 86400000);
    if (days < 0) return { status: 'status-danger', text: `Vencido · ${formatDate(expiry)}`, days };
    if (days <= 30) return { status: 'status-warning', text: `Vence em ${days}d · ${formatDate(expiry)}`, days };
    return { status: 'status-good', text: formatDate(expiry), days };
  }

  function productPrice(product) {
    return Math.max(0, Number(product.cost || 0) * (1 + Number(product.margin || 0) / 100));
  }

  function getActivePromotion(productId) {
    return state.promotions.find(promo => promo.productId === productId && promo.active);
  }

  function promotionDiscount(promo, price) {
    if (!promo) return 0;
    return promo.type === 'percent' ? price * Number(promo.value) / 100 : Number(promo.value);
  }

  function applyCollectionSnapshot(name, snapshot) {
    const records = snapshot.docs.map(item => ({ ...item.data(), id: item.id }));
    if (name === 'produtos') state.products = records;
    if (name === 'servicos') state.services = records;
    if (name === 'promocoes') state.promotions = records;
    if (name === 'vendas') state.sales = records.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    if (name === 'financas') {
      const attendantConfig = records.find(item => item.id === 'config_atendentes');
      const attendantNames = attendantConfig && Array.isArray(attendantConfig.attendants)
        ? attendantConfig.attendants.filter(name => typeof name === 'string')
        : [];
      state.attendants = attendantNames.length
        ? attendantNames
        : DEFAULT_ATTENDANTS.slice();
      state.finances = records.filter(item => item.type === 'expense' || item.type === 'sale')
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      renderFinance();
      renderAttendants();
    }
    renderAll();
  }

  function watchCollection(name) {
    return new Promise((resolve, reject) => {
      let firstSnapshot = true;
      const unsubscribe = onSnapshot(collection(db, name), snapshot => {
        applyCollectionSnapshot(name, snapshot);
        snapshotCount += firstSnapshot ? 1 : 0;
        if (firstSnapshot) {
          firstSnapshot = false;
          resolve();
        }
        if (snapshotCount === COLLECTIONS.length) {
          cloudReady = true;
          lastCloudError = '';
          setConnectionStatus('live', 'Firestore sincronizado');
          renderCart();
        }
      }, error => {
        setConnectionStatus('error', 'Erro de conexão');
        if (!firstSnapshot && lastCloudError !== error.code) reportCloudError(error);
        lastCloudError = error.code || error.message;
        if (firstSnapshot) {
          firstSnapshot = false;
          reject(error);
        }
      });
      window.addEventListener('beforeunload', unsubscribe, { once: true });
    });
  }

  async function fetchCloudData() {
    await Promise.all(COLLECTIONS.map(name => watchCollection(name)));
  }

  async function startFirebase() {
    if (!firebaseConfigured()) {
      setConnectionStatus('error', 'Configure o Firebase');
      notify('Preencha firebaseConfig em script.js com as credenciais do seu projeto.', true);
      return;
    }
    try {
      const app = initializeApp(firebaseConfig);
      db = getFirestore(app);
      setConnectionStatus('pending', 'Carregando dados da nuvem…');
      await fetchCloudData();
    } catch (error) {
      cloudReady = false;
      setConnectionStatus('error', 'Falha ao conectar');
      reportCloudError(error);
    }
  }

  function showTab(tab) {
    $$('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === `tab-${tab}`));
    $$('.nav-link').forEach(link => link.classList.toggle('active', link.dataset.tab === tab));
    const titles = { inicio: 'Visão geral', estoque: 'Estoque', servicos: 'Serviços / Lounge', promocoes: 'Promoções', pdv: 'Ponto de venda', financeiro: 'Financeiro' };
    $('#pageTitle').textContent = titles[tab] || titles.inicio;
    $('#sidebar').classList.remove('open');
    $('#menuToggle').setAttribute('aria-expanded', 'false');
    if (tab === 'pdv') renderCart();
  }

  function setTagOptions(selected = '') {
    const tags = SECTOR_TAGS[$('#productSector').value] || [];
    const select = $('#productTag');
    select.innerHTML = tags.length
      ? `<option value="">Selecione a etiqueta</option>${tags.map(tag => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join('')}`
      : '<option value="">Selecione primeiro o setor</option>';
    select.disabled = !tags.length;
    if (tags.includes(selected)) select.value = selected;
  }

  function renderStock() {
    const query = $('#stockSearch').value.trim().toLowerCase();
    const sector = $('#stockFilter').value;
    const filtered = state.products.filter(product => {
      const matchesQuery = `${product.name} ${product.code || ''} ${product.brand || ''} ${product.tag || ''}`.toLowerCase().includes(query);
      return matchesQuery && (!sector || product.sector === sector);
    });
    $('#productsBody').innerHTML = filtered.length ? filtered.map(product => {
      const expiry = expiryState(product.expiry);
      const status = expiry.status ? `<span class="status-pill ${expiry.status}">${escapeHtml(expiry.text)}</span>` : '—';
      return `<tr>
        <td><div class="row-product"><span class="product-chip">${escapeHtml((product.name || '?').slice(0, 1).toUpperCase())}</span><span><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.brand || 'Sem marca')}</small></span></div></td>
        <td>${escapeHtml(product.code || '—')}</td><td><span class="tag">${escapeHtml(product.sector)}</span> <span class="tag tag-green">${escapeHtml(product.tag)}</span></td>
        <td>${Number(product.qty) || 0}</td><td>${currency(product.cost)}</td><td>${currency(productPrice(product))}</td><td>${status}</td>
        <td><div class="inline-actions"><button class="table-action" data-edit-product="${escapeHtml(product.id)}" title="Editar produto" aria-label="Editar ${escapeHtml(product.name)}">✎</button><button class="table-action delete" data-delete-product="${escapeHtml(product.id)}" title="Excluir produto" aria-label="Excluir ${escapeHtml(product.name)}">×</button></div></td></tr>`;
    }).join('') : '<tr><td colspan="8" class="empty-row">Nenhum produto encontrado. Cadastre um produto para começar.</td></tr>';

    const units = state.products.reduce((total, product) => total + (Number(product.qty) || 0), 0);
    const cost = state.products.reduce((total, product) => total + Number(product.cost || 0) * (Number(product.qty) || 0), 0);
    $('#stockTotal').textContent = units;
    $('#stockKinds').textContent = `${state.products.length} produto${state.products.length === 1 ? '' : 's'} cadastrado${state.products.length === 1 ? '' : 's'}`;
    $('#summaryProducts').textContent = state.products.length;
    $('#summaryUnits').textContent = units;
    $('#stockCostValue').textContent = currency(cost);
    $('#stockNavCount').textContent = units;
    const attention = state.products.filter(product => {
      const expiry = expiryState(product.expiry);
      return Number(product.qty) > 0 && ((expiry.days !== undefined && expiry.days <= 30) || Number(product.qty) <= 5);
    });
    $('#attentionCount').textContent = attention.length;
    renderAlerts(attention);
    renderPromotionProductSelect();
    renderCatalog();
  }

  function renderAlerts(products) {
    const alerts = products.slice().sort((a, b) => {
      const aDays = expiryState(a.expiry).days;
      const bDays = expiryState(b.expiry).days;
      return (aDays === undefined ? 9999 : aDays) - (bDays === undefined ? 9999 : bDays);
    }).slice(0, 5);
    $('#stockAlerts').innerHTML = alerts.length ? alerts.map(product => {
      const expiry = expiryState(product.expiry);
      const expired = expiry.days !== undefined && expiry.days < 0;
      const near = expiry.days !== undefined && expiry.days <= 30;
      const detail = near ? expiry.text : `Estoque baixo · ${product.qty} unidade${Number(product.qty) === 1 ? '' : 's'}`;
      return `<div class="alert-item"><span class="alert-marker ${expired || Number(product.qty) <= 2 ? 'danger' : 'warning'}"></span><span class="alert-copy"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(detail)}</small></span><span class="alert-qty">${Number(product.qty)} un.</span></div>`;
    }).join('') : '<div class="cart-empty">Tudo certo com o estoque.<br>Sem alertas no momento.</div>';
  }

  function resetProductForm() {
    $('#productForm').reset();
    $('#productId').value = '';
    $('#productMargin').value = '30';
    $('#productFormTitle').textContent = 'Novo produto';
    $('#saveProductButton').textContent = 'Salvar produto';
    $('#cancelProductEdit').classList.add('hidden');
    setTagOptions();
  }

  function editProduct(id) {
    const product = state.products.find(item => item.id === id);
    if (!product) return;
    $('#productId').value = product.id;
    $('#productCode').value = product.code || '';
    $('#productName').value = product.name;
    $('#productBrand').value = product.brand || '';
    $('#productQty').value = product.qty;
    $('#productCost').value = product.cost;
    $('#productMargin').value = product.margin;
    $('#productExpiry').value = product.expiry || '';
    $('#productSector').value = product.sector;
    setTagOptions(product.tag);
    $('#productFormTitle').textContent = 'Editar produto';
    $('#saveProductButton').textContent = 'Salvar alterações';
    $('#cancelProductEdit').classList.remove('hidden');
    $('#productForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function renderServices() {
    $('#serviceCount').textContent = state.services.length;
    $('#servicesGrid').innerHTML = state.services.length ? state.services.map(service => `
      <article class="service-card"><div class="service-actions"><button class="table-action" data-edit-service="${escapeHtml(service.id)}" aria-label="Editar ${escapeHtml(service.name)}">✎</button><button class="table-action delete" data-delete-service="${escapeHtml(service.id)}" aria-label="Excluir ${escapeHtml(service.name)}">×</button></div>
      <span class="service-card-icon">♨</span><h3>${escapeHtml(service.name)}</h3><p>${escapeHtml(service.description || 'Serviço do lounge')}</p>
      <div class="service-price-row"><span><small>Preço de venda</small><strong>${currency(service.price)}</strong></span><span><small>Custo estimado</small><strong>${currency(service.cost)}</strong></span></div></article>`).join('') : '<article class="card empty-row">Nenhum serviço cadastrado. Use o formulário para adicionar o primeiro serviço.</article>';
    renderCatalog();
  }

  function resetServiceForm() {
    $('#serviceForm').reset();
    $('#serviceId').value = '';
    $('#serviceCost').value = '0';
    $('#serviceFormTitle').textContent = 'Novo serviço';
    $('#saveServiceButton').textContent = 'Salvar serviço';
    $('#cancelServiceEdit').classList.add('hidden');
  }

  function editService(id) {
    const service = state.services.find(item => item.id === id);
    if (!service) return;
    $('#serviceId').value = service.id;
    $('#serviceName').value = service.name;
    $('#serviceDescription').value = service.description || '';
    $('#serviceCost').value = service.cost;
    $('#servicePrice').value = service.price;
    $('#serviceFormTitle').textContent = 'Editar serviço';
    $('#saveServiceButton').textContent = 'Salvar alterações';
    $('#cancelServiceEdit').classList.remove('hidden');
    $('#serviceForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function renderPromotionProductSelect() {
    const select = $('#promotionProduct');
    const selected = select.value;
    select.innerHTML = `<option value="">Selecione um produto</option>${state.products.map(product => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)} (${Number(product.qty)} un.)</option>`).join('')}`;
    if (state.products.some(product => product.id === selected)) select.value = selected;
  }

  function renderPromotions() {
    $('#promotionsBody').innerHTML = state.promotions.length ? state.promotions.map(promo => {
      const product = state.products.find(item => item.id === promo.productId);
      const discount = promo.type === 'percent' ? `${Number(promo.value)}%` : currency(promo.value);
      return `<tr><td>${escapeHtml(product ? product.name : 'Produto removido')}</td><td>${promo.type === 'percent' ? 'Percentual' : 'Valor fixo'}</td><td>A partir de ${Number(promo.minQty)} un.</td><td>${discount} por unidade</td>
      <td><button class="status-pill ${promo.active ? 'status-good' : ''}" data-toggle-promotion="${escapeHtml(promo.id)}">${promo.active ? 'Ativa' : 'Pausada'}</button></td><td><button class="table-action delete" data-delete-promotion="${escapeHtml(promo.id)}" aria-label="Excluir promoção">×</button></td></tr>`;
    }).join('') : '<tr><td colspan="6" class="empty-row">Nenhuma promoção cadastrada.</td></tr>';
  }

  function renderCatalog() {
    const search = $('#posSearch').value.trim().toLowerCase();
    const products = state.products.filter(product => `${product.name} ${product.brand || ''} ${product.tag || ''}`.toLowerCase().includes(search));
    const services = state.services.filter(service => `${service.name} ${service.description || ''}`.toLowerCase().includes(search));
    $('#posProductCount').textContent = products.length;
    $('#posServiceCount').textContent = services.length;
    $('#posProducts').innerHTML = products.length ? products.map(product => {
      const price = productPrice(product);
      const promo = getActivePromotion(product.id);
      const disabled = Number(product.qty) <= 0;
      return `<button class="catalog-item" data-add-product="${escapeHtml(product.id)}" ${disabled ? 'disabled' : ''}><span class="catalog-avatar">${escapeHtml(product.name.slice(0, 1).toUpperCase())}</span><span class="catalog-detail"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.tag)} · ${disabled ? 'Sem estoque' : `${Number(product.qty)} un. em estoque`}${promo ? ` · oferta a partir de ${promo.minQty}` : ''}</small></span><span class="catalog-price">${currency(price)}</span><span class="catalog-add">＋</span></button>`;
    }).join('') : '<div class="cart-empty">Nenhum produto encontrado.</div>';
    $('#posServices').innerHTML = services.length ? services.map(service => `<button class="catalog-item service-item" data-add-service="${escapeHtml(service.id)}"><span class="catalog-avatar">♨</span><span class="catalog-detail"><strong>${escapeHtml(service.name)}</strong><small>${escapeHtml(service.description || 'Serviço do lounge')}</small></span><span class="catalog-price">${currency(service.price)}</span><span class="catalog-add">＋</span></button>`).join('') : '<div class="cart-empty">Nenhum serviço cadastrado.</div>';
  }

  function renderAttendants() {
    const select = $('#attendantSelect');
    const selected = select.value;
    select.innerHTML = state.attendants.length
      ? state.attendants.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')
      : '<option value="">Cadastre um atendente</option>';
    if (state.attendants.includes(selected)) select.value = selected;
    else if (state.attendants.length) select.selectedIndex = 0;
    $('#removeAttendant').disabled = state.attendants.length <= 1;
  }

  function addToCart(type, id) {
    const item = type === 'product' ? state.products.find(product => product.id === id) : state.services.find(service => service.id === id);
    if (!item) return;
    const existing = cart.find(line => line.type === type && line.id === id);
    if (type === 'product') {
      const currentQty = existing ? existing.qty : 0;
      if (currentQty >= Number(item.qty)) return notify('Quantidade maior que o estoque disponível.', true);
    }
    if (existing) existing.qty += 1;
    else cart.push({ type, id, qty: 1 });
    renderCart();
  }

  function cartLineData(line) {
    if (line.type === 'product') {
      const product = state.products.find(item => item.id === line.id);
      if (!product) return null;
      const price = productPrice(product);
      const promo = getActivePromotion(product.id);
      const unitDiscount = promo && line.qty >= Number(promo.minQty) ? Math.min(price, promotionDiscount(promo, price)) : 0;
      return { name: product.name, price, cost: Number(product.cost), unitDiscount, subtotal: Math.max(0, price - unitDiscount) * line.qty };
    }
    const service = state.services.find(item => item.id === line.id);
    if (!service) return null;
    return { name: service.name, price: Number(service.price), cost: Number(service.cost), unitDiscount: 0, subtotal: Number(service.price) * line.qty };
  }

  function getCartTotals() {
    let subtotal = 0;
    let promoDiscount = 0;
    cart.forEach(line => {
      const data = cartLineData(line);
      if (!data) return;
      subtotal += data.price * line.qty;
      promoDiscount += data.unitDiscount * line.qty;
    });
    const manualInput = Math.max(0, Number($('#manualDiscount').value) || 0);
    const manualDiscount = Math.min(manualInput, Math.max(0, subtotal - promoDiscount));
    return { subtotal, promoDiscount, manualDiscount, total: Math.max(0, subtotal - promoDiscount - manualDiscount) };
  }

  function renderCart() {
    cart = cart.filter(line => cartLineData(line));
    $('#cartCount').textContent = cart.reduce((total, line) => total + line.qty, 0);
    $('#cartDate').textContent = dateTime();
    $('#cartLines').innerHTML = cart.length ? cart.map(line => {
      const data = cartLineData(line);
      const kind = line.type === 'product' ? 'Produto' : 'Serviço';
      return `<div class="cart-line"><div><div class="cart-line-title">${escapeHtml(data.name)}</div><div class="cart-line-sub">${kind} · ${currency(data.price)} cada</div>
        ${data.unitDiscount ? `<div class="discount-hint">Promoção aplicada: −${currency(data.unitDiscount)} / un.</div>` : ''}
        <div class="cart-line-controls"><button class="qty-control" data-cart-decrease="${line.type}:${escapeHtml(line.id)}" aria-label="Diminuir quantidade">−</button><span class="qty-value">${line.qty}</span><button class="qty-control" data-cart-increase="${line.type}:${escapeHtml(line.id)}" aria-label="Aumentar quantidade">＋</button><button class="remove-line" data-cart-remove="${line.type}:${escapeHtml(line.id)}" aria-label="Remover item">×</button></div></div>
        <span class="cart-line-total">${currency(data.subtotal)}</span></div>`;
    }).join('') : '<div class="cart-empty">Seu carrinho está vazio.<br>Adicione produtos ou serviços ao lado.</div>';
    const totals = getCartTotals();
    $('#cartSubtotal').textContent = currency(totals.subtotal);
    $('#promoSaving').textContent = `− ${currency(totals.promoDiscount)}`;
    $('#promoSavingRow').classList.toggle('hidden', totals.promoDiscount <= 0);
    $('#cartTotal').textContent = currency(totals.total);
    $('#discountReason').disabled = totals.manualDiscount <= 0;
    if (totals.manualDiscount <= 0) $('#discountReason').value = '';
    $('#finishSale').disabled = !cart.length || !cloudReady;
    $('#finishSale').style.opacity = cart.length && cloudReady ? '1' : '.55';
    renderCatalog();
  }

  function changeCartQuantity(key, delta) {
    const [type, ...rest] = key.split(':');
    const id = rest.join(':');
    const line = cart.find(item => item.type === type && item.id === id);
    if (!line) return;
    if (delta > 0 && type === 'product') {
      const product = state.products.find(item => item.id === id);
      if (!product || line.qty >= Number(product.qty)) return notify('Quantidade maior que o estoque disponível.', true);
    }
    line.qty += delta;
    if (line.qty <= 0) cart = cart.filter(item => item !== line);
    renderCart();
  }

  async function finalizeSale() {
    ensureCloud();
    if (!cart.length) throw new Error('Adicione produtos ou serviços antes de finalizar.');
    const totals = getCartTotals();
    const reason = $('#discountReason').value.trim();
    if (totals.manualDiscount > 0 && !reason) {
      $('#discountReason').focus();
      throw new Error('Informe a justificativa para o desconto manual.');
    }
    const attendant = $('#attendantSelect').value;
    if (!attendant || !state.attendants.includes(attendant)) throw new Error('Selecione um atendente válido.');

    const saleItems = cart.map(line => {
      const data = cartLineData(line);
      if (!data) throw new Error('Um item do carrinho não está mais disponível. Atualize o carrinho.');
      return {
        type: line.type, id: line.id, name: data.name, qty: line.qty,
        unitPrice: data.price, unitCost: data.cost,
        promoDiscount: data.unitDiscount * line.qty, total: data.subtotal
      };
    });
    const saleRef = doc(collection(db, 'vendas'));
    const financeRef = doc(collection(db, 'financas'));
    const productLines = cart.filter(line => line.type === 'product');
    const productRefs = productLines.map(line => ({ line, ref: doc(db, 'produtos', line.id) }));
    const timestamp = new Date().toISOString();
    const sale = {
      number: makeNumber(), date: timestamp, items: saleItems,
      subtotal: totals.subtotal, promoDiscount: totals.promoDiscount,
      manualDiscount: totals.manualDiscount, discountReason: totals.manualDiscount ? reason : '',
      total: totals.total, payment: $('#paymentMethod').value, attendant,
      cmv: saleItems.filter(item => item.type === 'product').reduce((sum, item) => sum + item.unitCost * item.qty, 0)
    };
    const financeEntry = {
      type: 'sale', relatedSaleId: saleRef.id, number: sale.number, date: timestamp,
      subtotal: sale.subtotal, total: sale.total, promoDiscount: sale.promoDiscount,
      manualDiscount: sale.manualDiscount, cmv: sale.cmv, payment: sale.payment, attendant
    };

    await runTransaction(db, async transaction => {
      const productSnapshots = await Promise.all(productRefs.map(item => transaction.get(item.ref)));
      productSnapshots.forEach((snapshot, index) => {
        const { line } = productRefs[index];
        if (!snapshot.exists()) throw new Error(`O produto "${line.id}" não existe mais no estoque.`);
        const currentQty = Number(snapshot.data().qty) || 0;
        if (currentQty < line.qty) throw new Error(`Estoque insuficiente para ${snapshot.data().name}. Disponível: ${currentQty}.`);
      });
      productSnapshots.forEach((snapshot, index) => {
        const { line, ref } = productRefs[index];
        transaction.update(ref, { qty: Number(snapshot.data().qty) - line.qty });
      });
      transaction.set(saleRef, sale);
      transaction.set(financeRef, financeEntry);
    });

    cart = [];
    $('#manualDiscount').value = '0';
    $('#discountReason').value = '';
    $('#saleModalMessage').textContent = `Total de ${currency(sale.total)} recebido via ${sale.payment}. Atendente: ${attendant}.`;
    $('#saleModal').classList.remove('hidden');
    renderCart();
  }

  function renderSales() {
    const query = $('#historySearch').value.trim().toLowerCase();
    const filtered = state.sales.filter(sale => `${sale.number || ''} ${sale.payment || ''} ${sale.attendant || ''} ${sale.discountReason || ''} ${(sale.items || []).map(item => item.name).join(' ')}`.toLowerCase().includes(query));
    const rowHtml = sale => {
      const names = (sale.items || []).map(item => `${escapeHtml(item.name)} ×${item.qty}`).join(', ');
      const discounts = Number(sale.promoDiscount || 0) + Number(sale.manualDiscount || 0);
      const manualNote = sale.manualDiscount > 0 ? `<span class="table-subtext">${escapeHtml(sale.discountReason || 'Sem justificativa')}</span>` : '';
      return `<tr><td><span class="sale-id">#${escapeHtml(sale.number || '')}</span><span class="table-subtext">${escapeHtml(sale.attendant || 'Sem atendente')}</span></td><td>${dateTime(sale.date)}</td><td><span class="history-items">${names || '—'}</span></td><td><span class="tag">${escapeHtml(sale.payment || '—')}</span></td><td>${discounts ? currency(discounts) : '—'}${manualNote}</td><td class="align-right"><strong>${currency(sale.total)}</strong></td></tr>`;
    };
    $('#salesHistoryBody').innerHTML = filtered.length ? filtered.map(rowHtml).join('') : '<tr><td colspan="6" class="empty-row">Nenhuma venda registrada.</td></tr>';
    $('#recentSalesBody').innerHTML = state.sales.length ? state.sales.slice(0, 5).map(sale => `<tr><td><span class="sale-id">#${escapeHtml(sale.number || '')}</span><span class="table-subtext">${escapeHtml(sale.attendant || '')}</span></td><td>${dateTime(sale.date)}</td><td>${(sale.items || []).reduce((sum, item) => sum + Number(item.qty), 0)} item(ns)</td><td><span class="tag">${escapeHtml(sale.payment || '—')}</span></td><td class="align-right"><strong>${currency(sale.total)}</strong></td></tr>`).join('') : '<tr><td colspan="5" class="empty-row">As vendas aparecerão aqui após a primeira venda.</td></tr>';
  }

  function renderFinance() {
    const monthSales = state.sales.filter(sale => isCurrentMonth(sale.date));
    const monthExpenses = state.finances.filter(entry => entry.type === 'expense' && isCurrentMonth(entry.date));
    const gross = monthSales.reduce((sum, sale) => sum + Number(sale.subtotal === undefined ? sale.total || 0 : sale.subtotal), 0);
    const cmv = monthSales.reduce((sum, sale) => sum + Number(sale.cmv || 0), 0);
    const expenses = monthExpenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
    const discounts = monthSales.reduce((sum, sale) => sum + Number(sale.promoDiscount || 0) + Number(sale.manualDiscount || 0), 0);
    const serviceCosts = monthSales.reduce((sum, sale) => sum + (sale.items || []).filter(item => item.type === 'service').reduce((total, item) => total + Number(item.unitCost || 0) * Number(item.qty || 0), 0), 0);
    $('#financeGross').textContent = currency(gross);
    $('#financeCmv').textContent = currency(cmv);
    $('#financeExpenses').textContent = currency(expenses);
    $('#financeDiscounts').textContent = currency(discounts);
    $('#financeProfit').textContent = currency(gross - discounts - cmv - serviceCosts - expenses);
    $('#financeMonth').textContent = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    $('#expensesList').innerHTML = monthExpenses.length ? monthExpenses.slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).map(expense => `<div class="expense-entry"><span><strong>${escapeHtml(expense.description)}</strong><small>${escapeHtml(expense.category)} · ${formatDate(expense.date)}</small></span><span class="expense-value">− ${currency(expense.amount)}</span></div>`).join('') : '<div class="cart-empty">Nenhuma despesa registrada neste mês.</div>';
    const todaySales = state.sales.filter(sale => dateOnly(sale.date) === dateOnly(new Date()));
    const todayAmount = todaySales.reduce((sum, sale) => sum + Number(sale.total || 0), 0);
    $('#todayRevenue').textContent = currency(todayAmount);
    $('#todaySalesCount').textContent = `${todaySales.length} venda${todaySales.length === 1 ? '' : 's'} realizada${todaySales.length === 1 ? '' : 's'}`;
    $('#monthRevenue').textContent = currency(monthSales.reduce((sum, sale) => sum + Number(sale.total || 0), 0));
    $('#monthSalesCount').textContent = `${monthSales.length} venda${monthSales.length === 1 ? '' : 's'} realizada${monthSales.length === 1 ? '' : 's'}`;
  }

  function renderAll() {
    renderStock();
    renderServices();
    renderPromotions();
    renderSales();
    renderFinance();
    renderAttendants();
    renderCart();
  }

  async function updateAttendants(change) {
    ensureCloud();
    const configRef = doc(db, 'financas', 'config_atendentes');
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(configRef);
      const storedNames = snapshot.exists() && Array.isArray(snapshot.data().attendants)
        ? snapshot.data().attendants.filter(name => typeof name === 'string')
        : DEFAULT_ATTENDANTS;
      const attendants = [...new Set(change(storedNames.slice()).map(name => name.trim()).filter(Boolean))];
      if (!attendants.length) throw new Error('Mantenha pelo menos um atendente cadastrado.');
      transaction.set(configRef, { type: 'config', attendants, updatedAt: new Date().toISOString() });
    });
  }

  $('#todayLabel').textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  $('#expenseDate').value = dateOnly(new Date());
  $$('.nav-link').forEach(link => link.addEventListener('click', () => showTab(link.dataset.tab)));
  $$('[data-goto]').forEach(button => button.addEventListener('click', () => showTab(button.dataset.goto)));
  $('#menuToggle').addEventListener('click', () => {
    const open = $('#sidebar').classList.toggle('open');
    $('#menuToggle').setAttribute('aria-expanded', String(open));
  });

  $('#productSector').addEventListener('change', () => setTagOptions());
  $('#productForm').addEventListener('submit', event => {
    event.preventDefault();
    runCloudAction(async () => {
      const id = $('#productId').value;
      const product = {
        code: $('#productCode').value.trim(), name: $('#productName').value.trim(),
        brand: $('#productBrand').value.trim(), qty: Number($('#productQty').value),
        cost: Number($('#productCost').value), margin: Number($('#productMargin').value),
        expiry: $('#productExpiry').value, sector: $('#productSector').value, tag: $('#productTag').value
      };
      if (!product.name || !SECTOR_TAGS[product.sector] || !SECTOR_TAGS[product.sector].includes(product.tag) || product.qty < 0 || product.cost < 0 || product.margin < 0) throw new Error('Confira os dados do produto antes de salvar.');
      if (id) await updateDoc(doc(db, 'produtos', id), product);
      else await setDoc(doc(collection(db, 'produtos')), product);
      resetProductForm();
    }, $('#productId').value ? 'Produto atualizado na nuvem.' : 'Produto cadastrado na nuvem.');
  });
  $('#cancelProductEdit').addEventListener('click', resetProductForm);
  $('#productsBody').addEventListener('click', event => {
    const edit = event.target.closest('[data-edit-product]');
    const remove = event.target.closest('[data-delete-product]');
    if (edit) return editProduct(edit.dataset.editProduct);
    if (remove) {
      const product = state.products.find(item => item.id === remove.dataset.deleteProduct);
      if (!product || !window.confirm(`Excluir "${product.name}"? Esta ação não pode ser desfeita.`)) return;
      runCloudAction(async () => {
        await deleteDoc(doc(db, 'produtos', product.id));
        const linkedPromotions = state.promotions.filter(promo => promo.productId === product.id);
        await Promise.all(linkedPromotions.map(promo => deleteDoc(doc(db, 'promocoes', promo.id))));
        cart = cart.filter(line => !(line.type === 'product' && line.id === product.id));
      }, 'Produto excluído da nuvem.');
    }
  });
  $('#stockSearch').addEventListener('input', renderStock);
  $('#stockFilter').addEventListener('change', renderStock);

  $('#serviceForm').addEventListener('submit', event => {
    event.preventDefault();
    runCloudAction(async () => {
      const id = $('#serviceId').value;
      const service = {
        name: $('#serviceName').value.trim(), description: $('#serviceDescription').value.trim(),
        cost: Number($('#serviceCost').value), price: Number($('#servicePrice').value)
      };
      if (!service.name || service.cost < 0 || service.price < 0) throw new Error('Confira os dados do serviço antes de salvar.');
      if (id) await updateDoc(doc(db, 'servicos', id), service);
      else await setDoc(doc(collection(db, 'servicos')), service);
      resetServiceForm();
    }, $('#serviceId').value ? 'Serviço atualizado na nuvem.' : 'Serviço cadastrado na nuvem.');
  });
  $('#cancelServiceEdit').addEventListener('click', resetServiceForm);
  $('#servicesGrid').addEventListener('click', event => {
    const edit = event.target.closest('[data-edit-service]');
    const remove = event.target.closest('[data-delete-service]');
    if (edit) return editService(edit.dataset.editService);
    if (remove) {
      const service = state.services.find(item => item.id === remove.dataset.deleteService);
      if (!service || !window.confirm(`Excluir o serviço "${service.name}"?`)) return;
      runCloudAction(() => deleteDoc(doc(db, 'servicos', service.id)), 'Serviço excluído da nuvem.');
    }
  });

  $('#promotionForm').addEventListener('submit', event => {
    event.preventDefault();
    runCloudAction(async () => {
      const productId = $('#promotionProduct').value;
      const type = $('#promotionType').value;
      const value = Number($('#promotionValue').value);
      const minQty = Number($('#promotionMinQty').value);
      const product = state.products.find(item => item.id === productId);
      if (!product || value <= 0 || minQty < 1) throw new Error('Informe produto, desconto e quantidade válidos.');
      if (type === 'percent' && value > 100) throw new Error('O desconto percentual não pode ultrapassar 100%.');
      if (type === 'fixed' && value >= productPrice(product)) throw new Error('O desconto fixo deve ser menor que o preço de venda do produto.');
      await setDoc(doc(collection(db, 'promocoes')), { productId, type, value, minQty, active: $('#promotionActive').checked });
      $('#promotionForm').reset();
      $('#promotionMinQty').value = '6';
      $('#promotionActive').checked = true;
    }, 'Promoção salva na nuvem.');
  });
  $('#promotionsBody').addEventListener('click', event => {
    const toggle = event.target.closest('[data-toggle-promotion]');
    const remove = event.target.closest('[data-delete-promotion]');
    if (toggle) {
      const promo = state.promotions.find(item => item.id === toggle.dataset.togglePromotion);
      if (promo) runCloudAction(() => updateDoc(doc(db, 'promocoes', promo.id), { active: !promo.active }), 'Status da promoção atualizado.');
    }
    if (remove) runCloudAction(() => deleteDoc(doc(db, 'promocoes', remove.dataset.deletePromotion)), 'Promoção excluída da nuvem.');
  });

  $('#posSearch').addEventListener('input', renderCatalog);
  $('#posProducts').addEventListener('click', event => {
    const button = event.target.closest('[data-add-product]');
    if (button) addToCart('product', button.dataset.addProduct);
  });
  $('#posServices').addEventListener('click', event => {
    const button = event.target.closest('[data-add-service]');
    if (button) addToCart('service', button.dataset.addService);
  });
  $('#cartLines').addEventListener('click', event => {
    const increase = event.target.closest('[data-cart-increase]');
    const decrease = event.target.closest('[data-cart-decrease]');
    const remove = event.target.closest('[data-cart-remove]');
    if (increase) changeCartQuantity(increase.dataset.cartIncrease, 1);
    else if (decrease) changeCartQuantity(decrease.dataset.cartDecrease, -1);
    else if (remove) {
      const [type, ...rest] = remove.dataset.cartRemove.split(':');
      const id = rest.join(':');
      cart = cart.filter(item => item.type !== type || item.id !== id);
      renderCart();
    }
  });
  $('#manualDiscount').addEventListener('input', renderCart);
  $('#clearCart').addEventListener('click', () => {
    cart = [];
    $('#manualDiscount').value = '0';
    $('#discountReason').value = '';
    renderCart();
  });
  $('#finishSale').addEventListener('click', () => runCloudAction(finalizeSale));
  $('#closeSaleModal').addEventListener('click', () => { $('#saleModal').classList.add('hidden'); showTab('financeiro'); });
  $('#saleModal').addEventListener('click', event => { if (event.target === $('#saleModal')) $('#saleModal').classList.add('hidden'); });

  $('#expenseForm').addEventListener('submit', event => {
    event.preventDefault();
    runCloudAction(async () => {
      const expense = {
        type: 'expense',
        description: $('#expenseDescription').value.trim(),
        category: $('#expenseCategory').value,
        amount: Number($('#expenseAmount').value),
        date: $('#expenseDate').value
      };
      if (!expense.description || !expense.date || expense.amount <= 0) throw new Error('Informe descrição, data e um valor maior que zero.');
      await setDoc(doc(collection(db, 'financas')), expense);
      $('#expenseForm').reset();
      $('#expenseDate').value = dateOnly(new Date());
    }, 'Despesa registrada na nuvem.');
  });
  $$('.expense-quick button').forEach(button => button.addEventListener('click', () => {
    $('#expenseDescription').value = button.dataset.expense;
    $('#expenseCategory').value = 'Fixa';
    $('#expenseAmount').focus();
  }));
  $('#historySearch').addEventListener('input', renderSales);

  $('#addAttendant').addEventListener('click', () => runCloudAction(async () => {
    const name = $('#attendantNewName').value.trim();
    if (!name) throw new Error('Informe o nome do novo atendente.');
    await updateAttendants(names => {
      if (names.includes(name)) throw new Error('Este atendente já está cadastrado.');
      return [...names, name];
    });
    $('#attendantNewName').value = '';
  }, 'Atendente adicionado para todos os caixas.'));
  $('#renameAttendant').addEventListener('click', () => runCloudAction(async () => {
    const oldName = $('#attendantSelect').value;
    const newName = $('#attendantNewName').value.trim();
    if (!oldName || !newName) throw new Error('Selecione um atendente e informe o novo nome.');
    await updateAttendants(names => {
      if (!names.includes(oldName)) throw new Error('O atendente selecionado foi removido em outro caixa.');
      if (names.includes(newName)) throw new Error('Já existe um atendente com esse nome.');
      return names.map(name => name === oldName ? newName : name);
    });
    $('#attendantNewName').value = '';
  }, 'Atendente renomeado em todos os caixas.'));
  $('#removeAttendant').addEventListener('click', () => runCloudAction(async () => {
    const selected = $('#attendantSelect').value;
    if (!selected) throw new Error('Selecione um atendente para remover.');
    if (!window.confirm(`Remover "${selected}" dos atendentes disponíveis?`)) return;
    await updateAttendants(names => {
      if (!names.includes(selected)) throw new Error('O atendente selecionado foi removido em outro caixa.');
      if (names.length <= 1) throw new Error('Mantenha pelo menos um atendente cadastrado.');
      return names.filter(name => name !== selected);
    });
  }, 'Atendente removido em todos os caixas.'));

  $('#financeMonth').textContent = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  setTagOptions();
  renderAll();
  startFirebase();
})();
