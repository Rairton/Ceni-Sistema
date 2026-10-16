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

  const state = {
    products: [], services: [], promotions: [], sales: [], finances: [],
    attendants: DEFAULT_ATTENDANTS.slice(),
    paymentFees: { debit: 0, credit: 0, machinePix: 0 },
    paymentFeeHistory: []
  };
  const historyFilters = { rangeDays: null };
  const knownBatchCosts = new Map();
  const archivedBatchCosts = new Set();
  const saleRepairsInFlight = new Set();
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

  function saleDate(sale) {
    if (typeof sale.data === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sale.data)) return sale.data;
    return dateOnly(sale.date || new Date());
  }

  function saleTime(sale) {
    if (typeof sale.hora === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(sale.hora)) return sale.hora;
    const date = new Date(sale.date);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('pt-BR', { hour12: false });
  }

  function salePayment(sale) {
    return sale.formaPagamento || sale.payment || '—';
  }

  function normalizedPayment(value) {
    const payment = String(value || '').toLowerCase();
    if (payment.includes('dinheiro')) return 'Dinheiro';
    if (payment.includes('pix')) return 'PIX';
    if (payment.includes('débito') || payment.includes('debito')) return 'Débito';
    if (payment.includes('crédito') || payment.includes('credito')) return 'Crédito';
    return value || '—';
  }

  function saleGross(sale) {
    return Number(sale.subtotal ?? sale.valorBruto ?? sale.total ?? 0);
  }

  function hasNumericField(record, field) {
    return record[field] !== undefined && record[field] !== null && Number.isFinite(Number(record[field]));
  }

  function saleManualDiscount(sale) {
    return Number(sale.manualDiscount ?? sale.descontoManual ?? 0) || 0;
  }

  function salePromoDiscount(sale) {
    return Number(sale.promoDiscount ?? sale.descontoPromocional ?? 0) || 0;
  }

  function saleDiscount(sale) {
    if (hasNumericField(sale, 'valorDesconto')) return Number(sale.valorDesconto);
    return saleManualDiscount(sale) + salePromoDiscount(sale);
  }

  function saleDiscountReason(sale) {
    return sale.discountReason || sale.motivoDesconto || '';
  }

  function saleFeeRate(sale) {
    return hasNumericField(sale, 'taxaAplicada')
      ? Number(sale.taxaAplicada)
      : paymentFeeRate(salePayment(sale), sale.date || `${saleDate(sale)}T${saleTime(sale)}`);
  }

  function saleFee(sale) {
    if (hasNumericField(sale, 'valorTaxaDescontado')) return Number(sale.valorTaxaDescontado);
    if (hasNumericField(sale, 'feeAmount')) return Number(sale.feeAmount);
    return roundMoney(saleGross(sale) * saleFeeRate(sale) / 100);
  }

  function saleNet(sale) {
    if (hasNumericField(sale, 'valorLiquido')) return Number(sale.valorLiquido);
    return roundMoney(Math.max(0, saleGross(sale) - saleFee(sale) - saleDiscount(sale)));
  }

  function paymentFeeRate(payment, atDate = null) {
    const normalized = normalizedPayment(payment);
    let rates = state.paymentFees;
    if (atDate && state.paymentFeeHistory.length) {
      const timestamp = new Date(atDate).getTime();
      const historical = state.paymentFeeHistory
        .filter(entry => new Date(entry.effectiveAt).getTime() <= timestamp)
        .sort((a, b) => String(b.effectiveAt).localeCompare(String(a.effectiveAt)))[0];
      if (historical) rates = historical;
    }
    if (normalized === 'Débito') return Number(rates.debit) || 0;
    if (normalized === 'Crédito') return Number(rates.credit) || 0;
    if (String(payment).toLowerCase().includes('maquininha')) return Number(rates.machinePix) || 0;
    return 0;
  }

  function roundMoney(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }

  function monthKey(value) {
    const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T12:00:00`)
      : new Date(value);
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
    if (Number.isFinite(Number(product.salePrice))) return roundMoney(Math.max(0, Number(product.salePrice)));
    return roundMoney(Math.max(0, Number(product.cost || 0) * (1 + Number(product.margin || 0) / 100)));
  }

  function productBatches(product) {
    const batches = Array.isArray(product.batches)
      ? product.batches.filter(batch => Number(batch.qty) > 0).map((batch, index) => ({
        id: batch.id || `lote-${index + 1}`,
        qty: Number(batch.qty),
        unitCost: Number(batch.unitCost ?? batch.cost ?? product.cost ?? 0),
        expiry: batch.expiry || '',
        receivedAt: batch.receivedAt || ''
      }))
      : [];
    const lotQty = batches.reduce((sum, batch) => sum + batch.qty, 0);
    const productQty = Number(product.qty) || 0;
    if (!batches.length && productQty > 0) {
      batches.push({
        id: `legado-${product.id}`,
        qty: productQty,
        unitCost: Number(product.cost) || 0,
        expiry: product.expiry || '',
        receivedAt: product.createdAt || ''
      });
    } else if (productQty > lotQty) {
      batches.push({
        id: `legado-${product.id}`,
        qty: productQty - lotQty,
        unitCost: Number(product.cost) || 0,
        expiry: product.expiry || '',
        receivedAt: product.createdAt || ''
      });
    }
    return batches.sort((a, b) => {
      if (!a.expiry && b.expiry) return 1;
      if (a.expiry && !b.expiry) return -1;
      if (a.expiry && b.expiry && a.expiry !== b.expiry) return a.expiry.localeCompare(b.expiry);
      return String(a.receivedAt).localeCompare(String(b.receivedAt));
    });
  }

  function weightedBatchCost(batches) {
    const qty = batches.reduce((sum, batch) => sum + Number(batch.qty), 0);
    return qty ? batches.reduce((sum, batch) => sum + Number(batch.unitCost) * Number(batch.qty), 0) / qty : 0;
  }

  function productMarginAtPrice(price, cost) {
    if (!Number(cost)) return price > 0 ? 100 : 0;
    return ((Number(price) - Number(cost)) / Number(cost)) * 100;
  }

  function allocateFifo(batches, qty) {
    let remaining = Number(qty);
    const updatedBatches = batches.map(batch => ({ ...batch }));
    const allocations = [];
    for (const batch of updatedBatches) {
      if (remaining <= 0) break;
      const taken = Math.min(batch.qty, remaining);
      if (taken <= 0) continue;
      batch.qty -= taken;
      remaining -= taken;
      allocations.push({
        batchId: batch.id,
        qty: taken,
        unitCost: Number(batch.unitCost),
        expiry: batch.expiry || ''
      });
    }
    if (remaining > 0) throw new Error(`Estoque insuficiente nos lotes. Faltam ${remaining} unidade(s).`);
    return { batches: updatedBatches.filter(batch => batch.qty > 0), allocations };
  }

  function getActivePromotion(productId) {
    return state.promotions.find(promo => promo.productId === productId && promo.active);
  }

  function promotionDiscount(promo, price) {
    if (!promo) return 0;
    return roundMoney(promo.type === 'percent' ? price * Number(promo.value) / 100 : Number(promo.value));
  }

  function rememberBatchCosts(products) {
    products.forEach(product => productBatches(product).forEach(batch => {
      knownBatchCosts.set(`${product.id}\u0000${batch.id}`, Number(batch.unitCost));
    }));
  }

  function batchCostKey(productId, batchId) {
    return `${productId}\u0000${batchId}`;
  }

  function batchCostArchiveRef(productId, batchId) {
    const archiveId = `lote_${encodeURIComponent(`${productId}_${batchId}`)}`;
    return doc(db, 'financas', archiveId);
  }

  function archiveBatchCost(productId, batch) {
    return {
      type: 'lot_cost',
      productId,
      batchId: batch.id,
      unitCost: Number(batch.unitCost),
      expiry: batch.expiry || '',
      receivedAt: batch.receivedAt || ''
    };
  }

  async function archiveProductBatchCosts(products) {
    const writes = [];
    products.forEach(product => productBatches(product).forEach(batch => {
      const key = batchCostKey(product.id, batch.id);
      if (archivedBatchCosts.has(key)) return;
      archivedBatchCosts.add(key);
      writes.push(setDoc(batchCostArchiveRef(product.id, batch.id), archiveBatchCost(product.id, batch))
        .catch(error => {
          archivedBatchCosts.delete(key);
          throw error;
        }));
    }));
    await Promise.all(writes);
  }

  function recoverSaleCosts(sale) {
    const sourceItems = Array.isArray(sale.items) ? sale.items : [];
    let cmv = 0;
    let serviceCosts = 0;
    let complete = true;
    let productsComplete = true;
    if (!sourceItems.length && saleGross(sale) > 0 && !hasNumericField(sale, 'cmv')) {
      complete = false;
      productsComplete = false;
    }
    const items = sourceItems.map(item => {
      if (item.type === 'service') {
        let serviceCost;
        if (hasNumericField(item, 'serviceCost')) serviceCost = Number(item.serviceCost);
        else if (hasNumericField(item, 'unitCost')) serviceCost = Number(item.unitCost) * Number(item.qty || 0);
        else if (hasNumericField(sale, 'serviceCosts')) return item;
        else {
          const service = state.services.find(entry => entry.id === item.id);
          if (service && hasNumericField(service, 'cost')) serviceCost = Number(service.cost) * Number(item.qty || 0);
          else complete = false;
        }
        if (serviceCost !== undefined) serviceCosts += serviceCost;
        return { ...item, ...(serviceCost === undefined ? {} : { serviceCost }) };
      }

      if (item.type !== 'product') return item;
      if (hasNumericField(sale, 'cmv') && !hasNumericField(item, 'cmv')) return item;
      let productCost;
      if (hasNumericField(item, 'cmv')) productCost = Number(item.cmv);
      else if (Array.isArray(item.lotAllocations) && item.lotAllocations.length) {
        let allocatedCost = 0;
        let allocationsComplete = true;
        for (const allocation of item.lotAllocations) {
          const unitCost = hasNumericField(allocation, 'unitCost')
            ? Number(allocation.unitCost)
            : knownBatchCosts.get(`${item.id}\u0000${allocation.batchId}`);
          if (unitCost === undefined) {
            allocationsComplete = false;
            break;
          }
          allocatedCost += unitCost * Number(allocation.qty || 0);
        }
        if (allocationsComplete) productCost = allocatedCost;
        else {
          complete = false;
          productsComplete = false;
        }
      } else if (hasNumericField(item, 'unitCost')) {
        productCost = Number(item.unitCost) * Number(item.qty || 0);
      } else {
        complete = false;
        productsComplete = false;
      }

      if (productCost === undefined) return item;
      cmv += productCost;
      return {
        ...item,
        unitCost: Number(item.qty) ? productCost / Number(item.qty) : 0,
        cmv: productCost
      };
    });

    if (hasNumericField(sale, 'cmv')) cmv = Number(sale.cmv);
    if (hasNumericField(sale, 'serviceCosts')) serviceCosts = Number(sale.serviceCosts);
    if (hasNumericField(sale, 'cmv')) productsComplete = true;
    return { items, cmv: roundMoney(cmv), serviceCosts: roundMoney(serviceCosts), complete, productsComplete };
  }

  function saleProfit(sale) {
    if (sale.cmvDisponivel === false || sale.custosDisponiveis === false) return null;
    if (hasNumericField(sale, 'lucroLiquido')) return Number(sale.lucroLiquido);
    const costs = recoverSaleCosts(sale);
    if (!costs.complete) return null;
    return roundMoney(saleNet(sale) - costs.cmv - costs.serviceCosts);
  }

  function scheduleSaleRepairs() {
    if (!cloudReady || !db) return;
    state.sales.forEach(sale => {
      const needsFinancialRepair = !hasNumericField(sale, 'taxaAplicada')
        || !hasNumericField(sale, 'valorTaxaDescontado')
        || !hasNumericField(sale, 'valorDesconto')
        || !hasNumericField(sale, 'valorLiquido')
        || !hasNumericField(sale, 'valorBruto')
        || (sale.cmvDisponivel !== false && !hasNumericField(sale, 'cmv'));
      if (!needsFinancialRepair || saleRepairsInFlight.has(sale.id)) return;
      saleRepairsInFlight.add(sale.id);
      repairSaleFinancials(sale).catch(reportCloudError).finally(() => saleRepairsInFlight.delete(sale.id));
    });
  }

  async function repairSaleFinancials(sale) {
    const saleRef = doc(db, 'vendas', sale.id);
    const linkedFinance = state.finances.find(entry => entry.type === 'sale' && entry.relatedSaleId === sale.id);
    const financeRef = doc(db, 'financas', linkedFinance ? linkedFinance.id : `sale_${sale.id}`);

    await runTransaction(db, async transaction => {
      const [saleSnapshot, financeSnapshot] = await Promise.all([
        transaction.get(saleRef),
        transaction.get(financeRef)
      ]);
      if (!saleSnapshot.exists()) return;

      const current = { ...saleSnapshot.data(), id: sale.id };
      const valorBruto = roundMoney(saleGross(current));
      const taxaAplicada = saleFeeRate(current);
      const valorTaxaDescontado = roundMoney(valorBruto * taxaAplicada / 100);
      const valorDesconto = roundMoney(saleDiscount(current));
      const valorLiquido = roundMoney(Math.max(0, valorBruto - valorTaxaDescontado - valorDesconto));
      const costs = recoverSaleCosts(current);
      const manualDiscount = saleManualDiscount(current);
      const promoDiscount = salePromoDiscount(current);
      const reason = saleDiscountReason(current);
      const updates = {
        valorBruto,
        taxaAplicada,
        valorTaxaDescontado,
        valorDesconto,
        valorLiquido,
        total: valorLiquido,
        manualDiscount,
        descontoManual: manualDiscount,
        promoDiscount,
        descontoPromocional: promoDiscount,
        discountReason: reason,
        motivoDesconto: reason
      };
      if (costs.productsComplete) {
        updates.items = costs.items;
        updates.cmv = costs.cmv;
        updates.cmvDisponivel = true;
      } else {
        updates.cmvDisponivel = false;
      }
      if (costs.complete) {
        const lucroBruto = roundMoney(valorBruto - valorDesconto - costs.cmv - costs.serviceCosts);
        updates.serviceCosts = costs.serviceCosts;
        updates.lucroBruto = lucroBruto;
        updates.lucroLiquido = roundMoney(lucroBruto - valorTaxaDescontado);
        updates.custosDisponiveis = true;
      } else {
        updates.custosDisponiveis = false;
      }
      transaction.update(saleRef, updates);

      const payment = salePayment(current);
      transaction.set(financeRef, {
        ...(financeSnapshot.exists() ? financeSnapshot.data() : {}),
        type: 'sale',
        relatedSaleId: sale.id,
        number: current.number || sale.id,
        date: current.date || new Date().toISOString(),
        data: saleDate(current),
        hora: saleTime(current),
        amount: valorLiquido,
        subtotal: valorBruto,
        total: valorLiquido,
        valorBruto,
        taxaAplicada,
        valorTaxaDescontado,
        valorDesconto,
        valorLiquido,
        formaPagamento: payment,
        payment,
        atendente: current.atendente || current.attendant || 'Sem atendente',
        attendant: current.attendant || current.atendente || 'Sem atendente',
        manualDiscount,
        promoDiscount,
        discountReason: reason,
        motivoDesconto: reason,
        ...(costs.productsComplete ? { cmv: costs.cmv } : {}),
        ...(costs.complete ? {
          serviceCosts: costs.serviceCosts,
          lucroBruto: updates.lucroBruto,
          lucroLiquido: updates.lucroLiquido
        } : {})
      }, { merge: true });
    });
  }

  async function applyCollectionSnapshot(name, snapshot) {
    const records = snapshot.docs.map(item => ({ ...item.data(), id: item.id }));
    if (name === 'produtos') {
      state.products = records;
      rememberBatchCosts(records);
      await archiveProductBatchCosts(records);
    }
    if (name === 'servicos') state.services = records;
    if (name === 'promocoes') state.promotions = records;
    if (name === 'vendas') {
      state.sales = records.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      scheduleSaleRepairs();
    }
    if (name === 'financas') {
      records.filter(item => item.type === 'lot_cost').forEach(item => {
        if (!item.productId || !item.batchId || !hasNumericField(item, 'unitCost')) return;
        const key = batchCostKey(item.productId, item.batchId);
        knownBatchCosts.set(key, Number(item.unitCost));
        archivedBatchCosts.add(key);
      });
      const attendantConfig = records.find(item => item.id === 'config_atendentes');
      const feeConfig = records.find(item => item.id === 'config_taxas');
      state.paymentFeeHistory = records
        .filter(item => item.type === 'payment_fee_history' && typeof item.effectiveAt === 'string')
        .sort((a, b) => String(a.effectiveAt).localeCompare(String(b.effectiveAt)));
      const attendantNames = attendantConfig && Array.isArray(attendantConfig.attendants)
        ? attendantConfig.attendants.filter(name => typeof name === 'string')
        : [];
      state.attendants = attendantNames.length
        ? attendantNames
        : DEFAULT_ATTENDANTS.slice();
      state.finances = records.filter(item => item.type === 'expense' || item.type === 'sale')
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      if (feeConfig) {
        state.paymentFees = {
          debit: Number(feeConfig.debit) || 0,
          credit: Number(feeConfig.credit) || 0,
          machinePix: Number(feeConfig.machinePix) || 0
        };
        const effectiveAt = feeConfig.updatedAt || new Date(0).toISOString();
        if (!state.paymentFeeHistory.some(entry => entry.effectiveAt === effectiveAt)) {
          state.paymentFeeHistory.push({ ...state.paymentFees, effectiveAt });
          state.paymentFeeHistory.sort((a, b) => String(a.effectiveAt).localeCompare(String(b.effectiveAt)));
        }
      } else if (state.paymentFeeHistory.length) {
        const latestFees = state.paymentFeeHistory[state.paymentFeeHistory.length - 1];
        state.paymentFees = {
          debit: Number(latestFees.debit) || 0,
          credit: Number(latestFees.credit) || 0,
          machinePix: Number(latestFees.machinePix) || 0
        };
      }
      scheduleSaleRepairs();
      renderFeeSettings();
      renderFinance();
      renderAttendants();
    }
    renderAll();
  }

  function watchCollection(name) {
    return new Promise((resolve, reject) => {
      let firstSnapshot = true;
      const unsubscribe = onSnapshot(collection(db, name), async snapshot => {
        try {
          await applyCollectionSnapshot(name, snapshot);
          snapshotCount += firstSnapshot ? 1 : 0;
          if (firstSnapshot) {
            firstSnapshot = false;
            resolve();
          }
          if (snapshotCount === COLLECTIONS.length) {
            cloudReady = true;
            lastCloudError = '';
            setConnectionStatus('live', 'Firestore sincronizado');
            scheduleSaleRepairs();
            renderCart();
          }
        } catch (error) {
          cloudReady = false;
          setConnectionStatus('error', 'Erro ao arquivar lotes');
          reportCloudError(error);
          if (firstSnapshot) {
            firstSnapshot = false;
            reject(error);
          }
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
    const titles = { inicio: 'Visão geral', estoque: 'Estoque', servicos: 'Serviços / Lounge', promocoes: 'Promoções', pdv: 'Ponto de venda', financeiro: 'Financeiro', atendentes: 'Atendentes' };
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
      const batches = productBatches(product);
      const nearestExpiry = batches.find(batch => batch.expiry);
      const expiry = expiryState(nearestExpiry ? nearestExpiry.expiry : product.expiry);
      const status = expiry.status ? `<span class="status-pill ${expiry.status}">${escapeHtml(expiry.text)}</span>` : '—';
      return `<tr>
        <td><div class="row-product"><span class="product-chip">${escapeHtml((product.name || '?').slice(0, 1).toUpperCase())}</span><span><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.brand || 'Sem marca')}</small></span></div></td>
        <td>${escapeHtml(product.code || '—')}</td><td><span class="tag">${escapeHtml(product.sector)}</span> <span class="tag tag-green">${escapeHtml(product.tag)}</span></td>
        <td>${Number(product.qty) || 0}<span class="table-subtext">${batches.length} lote(s)</span></td><td>${currency(weightedBatchCost(batches))}</td><td>${currency(productPrice(product))}<span class="table-subtext">margem média ${productMarginAtPrice(productPrice(product), weightedBatchCost(batches)).toFixed(1)}%</span></td><td>${status}</td>
        <td><div class="inline-actions"><button class="table-action restock-action" data-restock-product="${escapeHtml(product.id)}" title="Reabastecer / + Lote" aria-label="Reabastecer ${escapeHtml(product.name)}">＋ Lote</button><button class="table-action" data-edit-product="${escapeHtml(product.id)}" title="Editar produto" aria-label="Editar ${escapeHtml(product.name)}">✎</button><button class="table-action delete" data-delete-product="${escapeHtml(product.id)}" title="Excluir produto" aria-label="Excluir ${escapeHtml(product.name)}">×</button></div></td></tr>`;
    }).join('') : '<tr><td colspan="8" class="empty-row">Nenhum produto encontrado. Cadastre um produto para começar.</td></tr>';

    const units = state.products.reduce((total, product) => total + (Number(product.qty) || 0), 0);
    const cost = state.products.reduce((total, product) => total + productBatches(product).reduce((lotTotal, batch) => lotTotal + batch.unitCost * batch.qty, 0), 0);
    $('#stockTotal').textContent = units;
    $('#stockKinds').textContent = `${state.products.length} produto${state.products.length === 1 ? '' : 's'} cadastrado${state.products.length === 1 ? '' : 's'}`;
    $('#summaryProducts').textContent = state.products.length;
    $('#summaryUnits').textContent = units;
    $('#stockCostValue').textContent = currency(cost);
    $('#stockNavCount').textContent = units;
    renderAlerts(state.products);
    renderPromotionProductSelect();
    renderCatalog();
  }

  function renderAlerts(products) {
    const alerts = [];
    let riskValue = 0;

    products.forEach(product => {
      const productName = product.name || 'Produto sem nome';
      const quantity = Number(product.qty) || 0;
      productBatches(product).forEach(batch => {
        const expiry = expiryState(batch.expiry);
        if (expiry.days === undefined || expiry.days > 30) return;

        const expired = expiry.days < 0;
        const risk = Math.max(0, Number(batch.qty) || 0) * Math.max(0, Number(batch.unitCost) || 0);
        riskValue += risk;
        alerts.push({
          productKey: product.id || productName,
          productName,
          type: expired ? 'expired' : 'expiring',
          days: expiry.days,
          detail: expired
            ? `Lote vencido · ${batch.qty} un. · venceu em ${formatDate(batch.expiry)}`
            : `Vence em ${expiry.days} dia${expiry.days === 1 ? '' : 's'} · ${batch.qty} un. · ${formatDate(batch.expiry)}`,
          quantity: batch.qty,
          risk
        });
      });

      if (quantity > 0 && quantity <= 5) {
        alerts.push({
          productKey: product.id || productName,
          productName,
          type: 'low-stock',
          days: Infinity,
          detail: `Estoque baixo · ${quantity} unidade${quantity === 1 ? '' : 's'}`,
          quantity,
          risk: 0
        });
      }
    });

    alerts.sort((a, b) => a.days - b.days || a.productName.localeCompare(b.productName));
    $('#attentionCount').textContent = new Set(alerts.map(alert => alert.productKey)).size;
    $('#stockRiskValue').textContent = currency(riskValue);
    $('#stockAlerts').innerHTML = alerts.length ? alerts.map(alert => {
      const marker = alert.type === 'expired' || (alert.type === 'low-stock' && alert.quantity <= 2)
        ? 'danger'
        : 'warning';
      const risk = alert.risk > 0 ? `<small>Em risco: ${currency(alert.risk)}</small>` : '';
      return `<div class="alert-item"><span class="alert-marker ${marker}"></span><span class="alert-copy"><strong>${escapeHtml(alert.productName)}</strong><small>${escapeHtml(alert.detail)}</small>${risk}</span><span class="alert-qty">${alert.quantity} un.</span></div>`;
    }).join('') : '<div class="cart-empty">Tudo certo com o estoque.<br>Sem alertas no momento.</div>';
  }

  function resetProductForm() {
    $('#productForm').reset();
    $('#productId').value = '';
    $('#productMargin').value = '30';
    $('#productFormTitle').textContent = 'Novo produto';
    $('#saveProductButton').textContent = 'Salvar produto';
    $('#cancelProductEdit').classList.add('hidden');
    $('#productInventoryHint').classList.add('hidden');
    $('#productQty').disabled = false;
    $('#productCost').disabled = false;
    $('#productMargin').disabled = false;
    $('#productExpiry').disabled = false;
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
    $('#productCost').value = weightedBatchCost(productBatches(product));
    $('#productMargin').value = product.margin;
    $('#productExpiry').value = product.expiry || '';
    $('#productSector').value = product.sector;
    setTagOptions(product.tag);
    $('#productFormTitle').textContent = 'Editar produto';
    $('#saveProductButton').textContent = 'Salvar alterações';
    $('#cancelProductEdit').classList.remove('hidden');
    $('#productInventoryHint').classList.remove('hidden');
    $('#productQty').disabled = true;
    $('#productCost').disabled = true;
    $('#productMargin').disabled = true;
    $('#productExpiry').disabled = true;
    $('#productForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function openRestockModal(productId) {
    const product = state.products.find(item => item.id === productId);
    if (!product) return;
    const batches = productBatches(product);
    const oldCost = weightedBatchCost(batches);
    $('#restockProductId').value = product.id;
    $('#restockProductName').textContent = product.name;
    $('#restockCurrentPrice').textContent = currency(productPrice(product));
    $('#restockOldCost').textContent = currency(oldCost);
    $('#restockQty').value = '';
    $('#restockUnitCost').value = '';
    $('#restockExpiry').value = '';
    $('#restockMargin').value = Number(product.margin) || 30;
    $('#restockSalePrice').value = productPrice(product).toFixed(2);
    $('#keepPriceLabel').textContent = `Manter Preço de Venda Atual (${currency(productPrice(product))})`;
    $('input[name="restockPricing"][value="keep"]').checked = true;
    $('#restockRepriceFields').classList.add('hidden');
    $('#restockModal').classList.remove('hidden');
    renderRestockPreview();
    $('#restockQty').focus();
  }

  function renderRestockPreview() {
    const product = state.products.find(item => item.id === $('#restockProductId').value);
    if (!product) return;
    const quantity = Math.max(0, Number($('#restockQty').value) || 0);
    const newCost = Math.max(0, Number($('#restockUnitCost').value) || 0);
    const currentPrice = productPrice(product);
    const oldBatches = productBatches(product);
    const oldQty = oldBatches.reduce((sum, batch) => sum + batch.qty, 0);
    const oldCost = weightedBatchCost(oldBatches);
    const desiredMargin = Math.max(0, Number($('#restockMargin').value) || 0);
    const suggestedPrice = roundMoney(newCost * (1 + desiredMargin / 100));
    const inputPrice = $('#restockSalePrice');
    if (document.activeElement !== inputPrice) inputPrice.value = suggestedPrice.toFixed(2);
    const selectedPrice = $('input[name="restockPricing"]:checked').value === 'recalculate'
      ? Math.max(0, Number(inputPrice.value) || 0)
      : currentPrice;
    const blendedCost = quantity + oldQty > 0
      ? (oldCost * oldQty + newCost * quantity) / (oldQty + quantity)
      : newCost;
    $('#restockCurrentPrice').textContent = currency(currentPrice);
    $('#restockOldCost').textContent = currency(oldCost);
    $('#restockNewCostPreview').textContent = currency(newCost);
    $('#keepPriceLabel').textContent = `Manter Preço de Venda Atual (${currency(currentPrice)})`;
    $('#keepMarginEstimate').textContent = `${productMarginAtPrice(currentPrice, newCost).toFixed(1)}%`;
    $('#newMarginEstimate').textContent = `${productMarginAtPrice(selectedPrice, newCost).toFixed(1)}%`;
    $('#blendedMarginEstimate').textContent = `${productMarginAtPrice(selectedPrice, blendedCost).toFixed(1)}%`;
    $('#restockRepriceFields').classList.toggle('hidden', $('input[name="restockPricing"]:checked').value !== 'recalculate');
  }

  function closeRestockModal() {
    $('#restockModal').classList.add('hidden');
    $('#restockForm').reset();
    $('#restockRepriceFields').classList.add('hidden');
  }

  async function registerRestock(event) {
    event.preventDefault();
    const submitButton = $('#confirmRestock');
    if (submitButton.disabled) return;
    submitButton.disabled = true;
    try {
      await runCloudAction(async () => {
      const productId = $('#restockProductId').value;
      const quantity = Number($('#restockQty').value);
      const unitCost = Number($('#restockUnitCost').value);
      const expiry = $('#restockExpiry').value;
      const pricingMode = $('input[name="restockPricing"]:checked').value;
      const margin = Number($('#restockMargin').value);
      const manualSalePrice = Number($('#restockSalePrice').value);
      if (!productId || !Number.isInteger(quantity) || quantity <= 0 || !Number.isFinite(unitCost) || unitCost < 0) {
        throw new Error('Informe uma quantidade inteira e um custo unitário válido.');
      }
      if (pricingMode === 'recalculate' && (!Number.isFinite(margin) || margin < 0 || !Number.isFinite(manualSalePrice) || manualSalePrice < 0)) {
        throw new Error('Informe uma margem e um preço de venda válidos.');
      }
      const productRef = doc(db, 'produtos', productId);
      let registeredBatch;
      await runTransaction(db, async transaction => {
        const snapshot = await transaction.get(productRef);
        if (!snapshot.exists()) throw new Error('Este produto não existe mais no estoque.');
        const product = { ...snapshot.data(), id: snapshot.id };
        const batches = productBatches(product);
        const salePrice = pricingMode === 'recalculate' ? manualSalePrice : productPrice(product);
        const newBatch = {
          id: `lote-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          qty: quantity,
          unitCost,
          expiry,
          receivedAt: new Date().toISOString(),
          salePriceAtReceipt: salePrice,
          marginAtReceipt: productMarginAtPrice(salePrice, unitCost)
        };
        registeredBatch = newBatch;
        batches.push(newBatch);
        const totalQty = batches.reduce((sum, batch) => sum + Number(batch.qty), 0);
        const averageCost = weightedBatchCost(batches);
        transaction.update(productRef, {
          batches,
          qty: totalQty,
          cost: averageCost,
          salePrice,
          margin: productMarginAtPrice(salePrice, averageCost),
          lastRestockedAt: new Date().toISOString()
        });
          transaction.set(batchCostArchiveRef(productId, newBatch.id), archiveBatchCost(productId, newBatch));
        });
        if (registeredBatch) {
          const key = batchCostKey(productId, registeredBatch.id);
          knownBatchCosts.set(key, registeredBatch.unitCost);
          archivedBatchCosts.add(key);
        }
        closeRestockModal();
      }, 'Novo lote registrado no Firestore.');
    } finally {
      submitButton.disabled = false;
    }
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
    renderAttendantSummary();
  }

  function renderAttendantSummary() {
    const grouped = new Map(state.attendants.map(name => [name, []]));
    state.sales.forEach(sale => {
      const name = sale.attendant || sale.atendente || 'Sem atendente';
      if (!grouped.has(name)) grouped.set(name, []);
      grouped.get(name).push(sale);
    });
    const rows = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
    $('#attendantsBody').innerHTML = rows.length ? rows.map(([name, sales]) => {
      const revenue = sales.reduce((sum, sale) => sum + saleNet(sale), 0);
      const manualDiscounts = sales.reduce((sum, sale) => sum + saleManualDiscount(sale), 0);
      const discountedSales = sales.filter(sale => saleManualDiscount(sale) > 0);
      const discountRows = discountedSales.map(sale => {
        const items = (sale.items || []).map(item => `${escapeHtml(item.name || 'Item')} ×${Number(item.qty) || 0}`).join(', ');
        return `<tr><td>${formatDate(saleDate(sale))}</td><td>${escapeHtml(saleTime(sale))}</td><td>${items || `Venda #${escapeHtml(sale.number || sale.id || '')}`}</td><td>${currency(saleManualDiscount(sale))}</td><td class="discount-reason-cell">${escapeHtml(saleDiscountReason(sale) || 'Sem justificativa informada')}</td></tr>`;
      }).join('');
      return `<tr class="attendant-summary-row"><td colspan="4"><details class="attendant-detail">
        <summary class="attendant-summary"><span><strong>${escapeHtml(name)}</strong><small>Ver ${discountedSales.length} desconto(s) manual(is)</small></span><strong>${sales.length}</strong><strong>${currency(revenue)}</strong><strong>${currency(manualDiscounts)}</strong></summary>
        <div class="attendant-discount-details"><div class="table-scroll"><table><thead><tr><th>DATA</th><th>HORA</th><th>PRODUTO / VENDA</th><th>DESCONTO</th><th>MOTIVO / JUSTIFICATIVA</th></tr></thead><tbody>
          ${discountRows || '<tr><td colspan="5" class="empty-row">Este atendente não concedeu descontos manuais.</td></tr>'}
        </tbody></table></div></div>
      </details></td></tr>`;
    }).join('') : '<tr><td colspan="4" class="empty-row">Nenhum atendente ou venda registrado.</td></tr>';
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
      return { name: product.name, price, cost: Number(product.cost), unitDiscount, subtotal: roundMoney(Math.max(0, price - unitDiscount) * line.qty) };
    }
    const service = state.services.find(item => item.id === line.id);
    if (!service) return null;
    return { name: service.name, price: Number(service.price), cost: Number(service.cost), unitDiscount: 0, subtotal: roundMoney(Number(service.price) * line.qty) };
  }

  function cartHasActivePromotion() {
    return cart.some(line => line.type === 'product' && getActivePromotion(line.id));
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
    const manualInput = cartHasActivePromotion() ? 0 : Math.max(0, Number($('#manualDiscount').value) || 0);
    const manualDiscount = Math.min(manualInput, Math.max(0, subtotal - promoDiscount));
    return { subtotal, promoDiscount, manualDiscount, total: Math.max(0, subtotal - promoDiscount - manualDiscount) };
  }

  function renderCart() {
    cart = cart.filter(line => cartLineData(line));
    const promotionBlocksManualDiscount = cartHasActivePromotion();
    $('#manualDiscount').disabled = promotionBlocksManualDiscount;
    $('#promotionDiscountNotice').classList.toggle('hidden', !promotionBlocksManualDiscount);
    if (promotionBlocksManualDiscount) {
      $('#manualDiscount').value = '0';
      $('#discountReason').value = '';
    }
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
    const payment = $('#paymentMethod').value;
    const feeRate = paymentFeeRate(payment);
    const feeAmount = roundMoney(totals.subtotal * feeRate / 100);
    $('#cartFeeLabel').textContent = `Taxa da maquininha (${feeRate.toLocaleString('pt-BR')}%)`;
    $('#cartFee').textContent = `− ${currency(feeAmount)}`;
    $('#cartNetTotal').textContent = currency(Math.max(0, totals.subtotal - totals.promoDiscount - totals.manualDiscount - feeAmount));
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
    if (cartHasActivePromotion() && totals.manualDiscount > 0) {
      throw new Error('Desconto manual indisponível para produtos em promoção.');
    }
    const reason = $('#discountReason').value.trim();
    if (totals.manualDiscount > 0 && !reason) {
      $('#discountReason').focus();
      throw new Error('Informe a justificativa para o desconto manual.');
    }
    const attendant = $('#attendantSelect').value;
    if (!attendant || !state.attendants.includes(attendant)) throw new Error('Selecione um atendente válido.');

    const saleLines = cart.map(line => {
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
    const now = new Date();
    const timestamp = now.toISOString();
    const formaPagamento = $('#paymentMethod').value;
    const taxaAplicada = paymentFeeRate(formaPagamento);
    const valorBruto = roundMoney(totals.subtotal);
    const valorDesconto = roundMoney(totals.promoDiscount + totals.manualDiscount);
    const valorTaxaDescontado = roundMoney(valorBruto * taxaAplicada / 100);
    const valorLiquido = roundMoney(Math.max(0, valorBruto - valorTaxaDescontado - valorDesconto));
    const saleBase = {
      number: makeNumber(), date: timestamp, data: dateOnly(now),
      hora: now.toLocaleTimeString('pt-BR', { hour12: false }),
      subtotal: totals.subtotal, promoDiscount: totals.promoDiscount,
      manualDiscount: totals.manualDiscount, descontoManual: totals.manualDiscount,
      valorDesconto, discountReason: totals.manualDiscount ? reason : '',
      motivoDesconto: totals.manualDiscount ? reason : '',
      total: valorLiquido, valorBruto, taxaAplicada, valorTaxaDescontado, valorLiquido,
      payment: formaPagamento, formaPagamento, attendant, atendente: attendant,
      origem: 'admin'
    };
    let committedSale;

    await runTransaction(db, async transaction => {
      const productSnapshots = await Promise.all(productRefs.map(item => transaction.get(item.ref)));
      const allocationsById = new Map();
      productSnapshots.forEach((snapshot, index) => {
        const { line } = productRefs[index];
        if (!snapshot.exists()) throw new Error(`O produto "${line.id}" não existe mais no estoque.`);
        const batches = productBatches({ ...snapshot.data(), id: line.id });
        const availableQty = batches.reduce((sum, batch) => sum + batch.qty, 0);
        if (availableQty < line.qty) throw new Error(`Estoque insuficiente para ${snapshot.data().name}. Disponível: ${availableQty}.`);
        allocationsById.set(line.id, allocateFifo(batches, line.qty));
      });

      const saleItems = saleLines.map(line => {
        const allocation = line.type === 'product' ? allocationsById.get(line.id) : null;
        const exactCost = allocation
          ? allocation.allocations.reduce((sum, lot) => sum + lot.unitCost * lot.qty, 0)
          : line.unitCost * line.qty;
        const productCost = allocation ? exactCost : 0;
        const serviceCost = line.type === 'service' ? exactCost : 0;
        return {
          ...line,
          unitCost: line.qty ? exactCost / line.qty : 0,
          cmv: productCost,
          serviceCost,
          lotAllocations: allocation ? allocation.allocations : [],
          _revenueBeforeManual: Number(line.total) || 0,
          _grossBeforeDiscount: roundMoney(Number(line.unitPrice) * Number(line.qty))
        };
      });
      const discountBase = saleItems.reduce((sum, item) => sum + item._revenueBeforeManual, 0);
      let manualDiscountRemaining = totals.manualDiscount;
      let feeRemaining = valorTaxaDescontado;
      const pricedItems = saleItems.map((item, index) => {
        const lastItem = index === saleItems.length - 1;
        const manualDiscountAllocated = lastItem
          ? roundMoney(manualDiscountRemaining)
          : roundMoney(discountBase > 0 ? totals.manualDiscount * item._revenueBeforeManual / discountBase : 0);
        manualDiscountRemaining = roundMoney(manualDiscountRemaining - manualDiscountAllocated);
        const valorPraticado = roundMoney(item._revenueBeforeManual - manualDiscountAllocated);
        const lucroBruto = roundMoney(valorPraticado - item.cmv - item.serviceCost);
        const taxaRateada = lastItem
          ? roundMoney(feeRemaining)
          : roundMoney(valorBruto > 0 ? valorTaxaDescontado * item._grossBeforeDiscount / valorBruto : 0);
        feeRemaining = roundMoney(feeRemaining - taxaRateada);
        const { _revenueBeforeManual, _grossBeforeDiscount, ...persistedItem } = item;
        return {
          ...persistedItem,
          manualDiscountAllocated,
          valorPraticado,
          taxaRateada,
          lucroBruto,
          lucroLiquido: roundMoney(lucroBruto - taxaRateada)
        };
      });
      const cmv = pricedItems.reduce((sum, item) => sum + Number(item.cmv || 0), 0);
      const lucroBruto = roundMoney(pricedItems.reduce((sum, item) => sum + Number(item.lucroBruto || 0), 0));
      const lucroLiquido = roundMoney(pricedItems.reduce((sum, item) => sum + Number(item.lucroLiquido || 0), 0));
      committedSale = { ...saleBase, items: pricedItems, cmv, lucroBruto, lucroLiquido };

      productSnapshots.forEach((snapshot, index) => {
        const { line, ref } = productRefs[index];
        const allocation = allocationsById.get(line.id);
        const updatedBatches = allocation.batches;
        const remainingQty = updatedBatches.reduce((sum, batch) => sum + batch.qty, 0);
        const averageCost = weightedBatchCost(updatedBatches);
        const salePrice = productPrice(snapshot.data());
        transaction.update(ref, {
          batches: updatedBatches,
          qty: remainingQty,
          cost: averageCost,
          margin: productMarginAtPrice(salePrice, averageCost)
        });
      });
      transaction.set(saleRef, committedSale);
      transaction.set(financeRef, {
        type: 'sale', relatedSaleId: saleRef.id, number: committedSale.number,
        date: timestamp, data: committedSale.data, hora: committedSale.hora,
        subtotal: committedSale.subtotal, total: committedSale.total,
        amount: valorLiquido, valorBruto, taxaAplicada, valorTaxaDescontado, valorDesconto, valorLiquido,
        formaPagamento, payment: formaPagamento, atendente: attendant, attendant,
        promoDiscount: committedSale.promoDiscount, manualDiscount: committedSale.manualDiscount,
        discountReason: committedSale.discountReason, motivoDesconto: committedSale.motivoDesconto,
        cmv: committedSale.cmv, lucroBruto: committedSale.lucroBruto,
        lucroLiquido: committedSale.lucroLiquido, items: committedSale.items
      });
    });

    cart = [];
    $('#manualDiscount').value = '0';
    $('#discountReason').value = '';
    $('#saleModalMessage').textContent = `${currency(committedSale.valorBruto)} recebidos via ${formaPagamento}; líquido após taxa: ${currency(committedSale.valorLiquido)}. Atendente: ${attendant}.`;
    $('#saleModal').classList.remove('hidden');
    renderCart();
  }

  function renderSales() {
    const query = $('#historySearch').value.trim().toLowerCase();
    const specificDate = $('#historyDateFilter').value;
    const paymentFilter = $('#historyPaymentFilter').value;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const fromDate = historyFilters.rangeDays
      ? new Date(today.getTime() - (historyFilters.rangeDays - 1) * 86400000)
      : null;
    const filtered = state.sales.filter(sale => {
      const saleDay = saleDate(sale);
      const saleDayStart = new Date(`${saleDay}T00:00:00`);
      const searchable = `${sale.number || ''} ${salePayment(sale)} ${sale.attendant || sale.atendente || ''} ${saleDiscountReason(sale)} ${(sale.items || []).map(item => item.name).join(' ')}`.toLowerCase();
      if (specificDate && saleDay !== specificDate) return false;
      if (!specificDate && fromDate && saleDayStart < fromDate) return false;
      if (paymentFilter && normalizedPayment(salePayment(sale)) !== paymentFilter) return false;
      return !query || searchable.includes(query);
    });
    const rowHtml = sale => {
      const names = (sale.items || []).map(item => `${escapeHtml(item.name)} ×${item.qty}`).join(', ');
      const attendant = sale.attendant || sale.atendente || 'Sem atendente';
      const reason = saleDiscountReason(sale);
      const discountCell = saleDiscount(sale) > 0
        ? `<strong>${currency(saleDiscount(sale))}</strong>${reason ? `<span class="table-subtext">${escapeHtml(reason)}</span>` : ''}`
        : '—';
      return `<tr><td><span class="sale-id">${escapeHtml(saleTime(sale))}</span><span class="table-subtext">#${escapeHtml(sale.number || sale.id || '')} · ${formatDate(saleDate(sale))}</span></td><td><span class="history-items">${names || '—'}</span></td><td>${escapeHtml(attendant)}</td><td><span class="tag">${escapeHtml(salePayment(sale))}</span></td><td>${currency(saleGross(sale))}</td><td class="history-discount-cell">${discountCell}</td><td>${currency(saleFee(sale))}${saleFeeRate(sale) ? `<span class="table-subtext">${saleFeeRate(sale)}%</span>` : ''}</td><td class="align-right"><strong>${currency(saleNet(sale))}</strong></td></tr>`;
    };
    $('#salesHistoryBody').innerHTML = filtered.length ? filtered.map(rowHtml).join('') : '<tr><td colspan="8" class="empty-row">Nenhuma venda corresponde aos filtros selecionados.</td></tr>';
    $('#recentSalesBody').innerHTML = state.sales.length ? state.sales.slice(0, 5).map(sale => `<tr><td><span class="sale-id">#${escapeHtml(sale.number || sale.id || '')}</span><span class="table-subtext">${escapeHtml(sale.attendant || sale.atendente || '')}</span></td><td>${dateTime(sale.date)}</td><td>${(sale.items || []).reduce((sum, item) => sum + Number(item.qty), 0)} item(ns)</td><td><span class="tag">${escapeHtml(salePayment(sale))}</span></td><td class="align-right"><strong>${currency(saleNet(sale))}</strong></td></tr>`).join('') : '<tr><td colspan="5" class="empty-row">As vendas aparecerão aqui após a primeira venda.</td></tr>';
    renderAttendantSummary();
  }

  function renderPreviousMonths() {
    const currentMonth = monthKey(new Date());
    const monthKeys = new Set();
    state.sales.forEach(sale => monthKeys.add(monthKey(`${saleDate(sale)}T12:00:00`)));
    state.finances.filter(entry => entry.type === 'expense').forEach(entry => monthKeys.add(monthKey(`${entry.date}T12:00:00`)));
    const previousKeys = [...monthKeys].filter(key => key < currentMonth).sort((a, b) => b.localeCompare(a));
    $('#previousMonths').innerHTML = previousKeys.length ? previousKeys.map(key => {
      const monthSales = state.sales.filter(sale => monthKey(`${saleDate(sale)}T12:00:00`) === key);
      const monthExpenses = state.finances.filter(entry => entry.type === 'expense' && monthKey(`${entry.date}T12:00:00`) === key);
      const gross = monthSales.reduce((sum, sale) => sum + saleGross(sale), 0);
      const fees = monthSales.reduce((sum, sale) => sum + saleFee(sale), 0);
      const monthCosts = monthSales.map(recoverSaleCosts);
      const cmvUnavailable = monthCosts.some(cost => !cost.productsComplete);
      const cmv = monthCosts.reduce((sum, cost) => sum + cost.cmv, 0);
      const discounts = monthSales.reduce((sum, sale) => sum + saleDiscount(sale), 0);
      const expenses = monthExpenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
      const monthProfits = monthSales.map(saleProfit);
      const missingCosts = monthProfits.some(value => value === null);
      const profitFromSales = monthSales.reduce((sum, sale) => {
        const profit = saleProfit(sale);
        return profit === null ? sum : sum + profit;
      }, 0);
      const profit = profitFromSales - expenses;
      const days = new Set([...monthSales.map(sale => saleDate(sale)), ...monthExpenses.map(expense => expense.date)]).size;
      const dayKeys = [...new Set([...monthSales.map(sale => saleDate(sale)), ...monthExpenses.map(expense => expense.date)])].sort((a, b) => b.localeCompare(a));
      return `<details class="month-detail"><summary>
        <span class="month-title"><strong>${new Date(`${key}-01T12:00:00`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}</strong><small>${monthSales.length} venda(s) · ${days} dia(s) movimentado(s)</small></span>
        <span class="month-summary-item"><small>Faturamento Bruto</small><strong>${currency(gross)}</strong></span>
        <span class="month-summary-item"><small>Total em Taxas</small><strong>${currency(fees)}</strong></span>
        <span class="month-summary-item"><small>CMV</small><strong>${cmvUnavailable ? 'Indisponível' : currency(cmv)}</strong></span>
        <span class="month-summary-item"><small>Despesas</small><strong>${currency(expenses)}</strong></span>
        <span class="month-summary-item month-profit"><small>Lucro Líquido Real</small><strong>${missingCosts ? 'CMV indisponível' : currency(profit)}</strong></span>
      </summary>
      <div class="month-days">${dayKeys.map(day => {
        const daySales = monthSales.filter(sale => saleDate(sale) === day);
        const dayExpenses = monthExpenses.filter(expense => expense.date === day);
        const dayGross = daySales.reduce((sum, sale) => sum + saleGross(sale), 0);
        const dayFees = daySales.reduce((sum, sale) => sum + saleFee(sale), 0);
        const dayNet = daySales.reduce((sum, sale) => sum + saleNet(sale), 0);
        return `<details class="day-detail"><summary><strong>${formatDate(day)}</strong><span>${daySales.length} venda(s)</span><span>Bruto ${currency(dayGross)}</span><span>Taxas ${currency(dayFees)}</span><span>Líquido ${currency(dayNet)}</span></summary>
          <div class="table-scroll"><table><thead><tr><th>HORA</th><th>VENDA / DESPESA</th><th>ATENDENTE / CATEGORIA</th><th>FORMA DE PAGAMENTO</th><th>BRUTO</th><th>DESCONTO / MOTIVO</th><th>TAXA / DESPESA</th><th>LÍQUIDO</th></tr></thead><tbody>
          ${daySales.map(sale => `<tr><td>${escapeHtml(saleTime(sale))}</td><td>#${escapeHtml(sale.number || sale.id || '')} · ${escapeHtml((sale.items || []).map(item => item.name).join(', '))}</td><td>${escapeHtml(sale.attendant || sale.atendente || '—')}</td><td>${escapeHtml(salePayment(sale))}</td><td>${currency(saleGross(sale))}</td><td>${saleDiscount(sale) ? `${currency(saleDiscount(sale))}${saleDiscountReason(sale) ? `<span class="table-subtext">${escapeHtml(saleDiscountReason(sale))}</span>` : ''}` : '—'}</td><td>${currency(saleFee(sale))}</td><td>${currency(saleNet(sale))}</td></tr>`).join('')}
          ${dayExpenses.map(expense => `<tr><td>—</td><td>${escapeHtml(expense.description)}</td><td>${escapeHtml(expense.category)}</td><td>Despesa</td><td>—</td><td>—</td><td>− ${currency(expense.amount)}</td><td>—</td></tr>`).join('')}
          ${daySales.length || dayExpenses.length ? '' : '<tr><td colspan="8" class="empty-row">Sem movimentações neste dia.</td></tr>'}
          </tbody></table></div></details>`;
      }).join('')}</div></details>`;
    }).join('') : '<div class="cart-empty">Os fechamentos dos meses anteriores aparecerão aqui.</div>';
  }

  function renderFeeSettings() {
    const fields = [
      ['feeDebit', state.paymentFees.debit],
      ['feeCredit', state.paymentFees.credit],
      ['feeMachinePix', state.paymentFees.machinePix]
    ];
    fields.forEach(([id, value]) => {
      const input = $(`#${id}`);
      if (document.activeElement !== input) input.value = Number(value) || 0;
    });
    renderCart();
  }

  function renderFinance() {
    const monthSales = state.sales.filter(sale => isCurrentMonth(saleDate(sale)));
    const monthExpenses = state.finances.filter(entry => entry.type === 'expense' && isCurrentMonth(entry.date));
    const gross = monthSales.reduce((sum, sale) => sum + saleGross(sale), 0);
    const monthCosts = monthSales.map(recoverSaleCosts);
    const cmvUnavailable = monthCosts.some(cost => !cost.productsComplete);
    const cmv = monthCosts.reduce((sum, cost) => sum + cost.cmv, 0);
    const expenses = monthExpenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
    const discounts = monthSales.reduce((sum, sale) => sum + saleDiscount(sale), 0);
    const monthFees = monthSales.reduce((sum, sale) => sum + saleFee(sale), 0);
    const totalFees = state.sales.reduce((sum, sale) => sum + saleFee(sale), 0);
    $('#financeGross').textContent = currency(gross);
    $('#financeCmv').textContent = cmvUnavailable ? '—' : currency(cmv);
    $('#financeCmvCaption').textContent = cmvUnavailable
      ? 'há venda(s) sem custo de lote recuperável'
      : 'custo dos produtos vendidos';
    $('#financeExpenses').textContent = currency(expenses);
    $('#financeDiscounts').textContent = currency(discounts);
    $('#financeFees').textContent = currency(totalFees);
    $('#financeFeesCaption').textContent = `acumulado em todo o histórico · ${currency(monthFees)} neste mês`;
    const monthProfits = monthSales.map(saleProfit);
    const hasMissingCost = monthProfits.some(value => value === null);
    const profitFromSales = monthProfits.reduce((sum, value) => sum + (value === null ? 0 : value), 0);
    $('#financeProfit').textContent = hasMissingCost ? '—' : currency(profitFromSales - expenses);
    $('#financeProfitCaption').textContent = hasMissingCost
      ? `${monthProfits.filter(value => value === null).length} venda(s) sem custos recuperáveis; resultado indisponível`
      : 'após descontos, taxas, CMV e despesas';
    $('#financeMonth').textContent = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    $('#expensesList').innerHTML = monthExpenses.length ? monthExpenses.slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).map(expense => `<div class="expense-entry"><span><strong>${escapeHtml(expense.description)}</strong><small>${escapeHtml(expense.category)} · ${formatDate(expense.date)}</small></span><span class="expense-value">− ${currency(expense.amount)}</span></div>`).join('') : '<div class="cart-empty">Nenhuma despesa registrada neste mês.</div>';
    const todaySales = state.sales.filter(sale => saleDate(sale) === dateOnly(new Date()));
    const todayAmount = todaySales.reduce((sum, sale) => sum + saleNet(sale), 0);
    $('#todayRevenue').textContent = currency(todayAmount);
    $('#todaySalesCount').textContent = `${todaySales.length} venda${todaySales.length === 1 ? '' : 's'} realizada${todaySales.length === 1 ? '' : 's'}`;
    $('#monthRevenue').textContent = currency(monthSales.reduce((sum, sale) => sum + saleNet(sale), 0));
    $('#monthSalesCount').textContent = `${monthSales.length} venda${monthSales.length === 1 ? '' : 's'} realizada${monthSales.length === 1 ? '' : 's'}`;
    renderPreviousMonths();
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
      const productFields = {
        code: $('#productCode').value.trim(), name: $('#productName').value.trim(),
        brand: $('#productBrand').value.trim(),
        sector: $('#productSector').value, tag: $('#productTag').value
      };
      if (!productFields.name || !SECTOR_TAGS[productFields.sector] || !SECTOR_TAGS[productFields.sector].includes(productFields.tag)) {
        throw new Error('Confira nome, setor e etiqueta antes de salvar.');
      }
      if (id) {
        const productRef = doc(db, 'produtos', id);
        await runTransaction(db, async transaction => {
          const snapshot = await transaction.get(productRef);
          if (!snapshot.exists()) throw new Error('Este produto não existe mais no estoque.');
          const current = { ...snapshot.data(), id };
          const batches = productBatches(current);
          const cost = weightedBatchCost(batches);
          transaction.update(productRef, {
            ...productFields,
            batches,
            qty: batches.reduce((sum, batch) => sum + batch.qty, 0),
            cost,
            salePrice: productPrice(current),
            margin: productMarginAtPrice(productPrice(current), cost)
          });
        });
      } else {
        const qty = Number($('#productQty').value);
        const cost = Number($('#productCost').value);
        const margin = Number($('#productMargin').value);
        const expiry = $('#productExpiry').value;
        if (!Number.isInteger(qty) || qty < 0 || !Number.isFinite(cost) || cost < 0 || !Number.isFinite(margin) || margin < 0) {
          throw new Error('Informe quantidade, custo e margem válidos.');
        }
        const productRef = doc(collection(db, 'produtos'));
        const salePrice = roundMoney(cost * (1 + margin / 100));
        const initialBatch = qty > 0 ? [{
          id: `lote-inicial-${Date.now()}`,
          qty,
          unitCost: cost,
          expiry,
          receivedAt: new Date().toISOString(),
          salePriceAtReceipt: salePrice,
          marginAtReceipt: margin
        }] : [];
        const newProduct = {
          ...productFields,
          qty,
          cost,
          margin,
          salePrice,
          expiry,
          batches: initialBatch,
          createdAt: new Date().toISOString()
        };
        await runTransaction(db, async transaction => {
          transaction.set(productRef, newProduct);
          if (initialBatch.length) {
            transaction.set(batchCostArchiveRef(productRef.id, initialBatch[0].id), archiveBatchCost(productRef.id, initialBatch[0]));
          }
        });
        if (initialBatch.length) {
          const key = batchCostKey(productRef.id, initialBatch[0].id);
          knownBatchCosts.set(key, cost);
          archivedBatchCosts.add(key);
        }
      }
      resetProductForm();
    }, $('#productId').value ? 'Produto atualizado na nuvem.' : 'Produto cadastrado na nuvem.');
  });
  $('#cancelProductEdit').addEventListener('click', resetProductForm);
  $('#productsBody').addEventListener('click', event => {
    const restock = event.target.closest('[data-restock-product]');
    const edit = event.target.closest('[data-edit-product]');
    const remove = event.target.closest('[data-delete-product]');
    if (restock) return openRestockModal(restock.dataset.restockProduct);
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
  $('#restockUnitCost').addEventListener('input', renderRestockPreview);
  $('#restockQty').addEventListener('input', renderRestockPreview);
  $('#restockMargin').addEventListener('input', renderRestockPreview);
  $('#restockSalePrice').addEventListener('input', renderRestockPreview);
  $$('input[name="restockPricing"]').forEach(input => input.addEventListener('change', renderRestockPreview));
  $('#restockForm').addEventListener('submit', registerRestock);
  $('#cancelRestock').addEventListener('click', closeRestockModal);
  $('#closeRestockModal').addEventListener('click', closeRestockModal);
  $('#restockModal').addEventListener('click', event => {
    if (event.target === $('#restockModal')) closeRestockModal();
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
  $('#paymentMethod').addEventListener('change', renderCart);
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
  $('#historyDateFilter').addEventListener('change', () => {
    historyFilters.rangeDays = null;
    $$('[data-history-range]').forEach(button => button.classList.toggle('active', button.dataset.historyRange === 'all' && !$('#historyDateFilter').value));
    renderSales();
  });
  $('#historyPaymentFilter').addEventListener('change', renderSales);
  $$('[data-history-range]').forEach(button => button.addEventListener('click', () => {
    const value = button.dataset.historyRange;
    historyFilters.rangeDays = value === '7' || value === '30' ? Number(value) : null;
    $('#historyDateFilter').value = '';
    $$('[data-history-range]').forEach(item => item.classList.toggle('active', item === button));
    renderSales();
  }));

  $('#feeSettingsForm').addEventListener('submit', event => {
    event.preventDefault();
    runCloudAction(async () => {
      const paymentFees = {
        debit: Number($('#feeDebit').value),
        credit: Number($('#feeCredit').value),
        machinePix: Number($('#feeMachinePix').value)
      };
      if (Object.values(paymentFees).some(value => !Number.isFinite(value) || value < 0 || value > 100)) {
        throw new Error('Informe taxas entre 0% e 100%.');
      }
      const effectiveAt = new Date().toISOString();
      const feeHistoryRef = doc(db, 'financas', `taxas_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
      await runTransaction(db, async transaction => {
        transaction.set(doc(db, 'financas', 'config_taxas'), {
          type: 'config', ...paymentFees, updatedAt: effectiveAt
        }, { merge: true });
        transaction.set(feeHistoryRef, {
          type: 'payment_fee_history',
          ...paymentFees,
          effectiveAt,
          updatedAt: effectiveAt
        });
      });
      state.paymentFees = paymentFees;
      state.paymentFeeHistory.push({ ...paymentFees, effectiveAt });
      state.paymentFeeHistory.sort((a, b) => String(a.effectiveAt).localeCompare(String(b.effectiveAt)));
      renderCart();
    }, 'Taxas salvas e sincronizadas com os outros caixas.');
  });

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
