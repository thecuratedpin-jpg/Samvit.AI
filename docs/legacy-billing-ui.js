// src/features/billing.js
// Billing UI feature module - handles subscription display, upgrades, and management

export async function getBillingStatus() {
  const res = await fetch('/api/billing-status', { credentials: 'same-origin' });
  if (!res.ok) {
    if (res.status === 401) throw new Error('NOT_AUTHENTICATED');
    throw new Error(`Failed to fetch billing status: ${res.status}`);
  }
  return res.json();
}

export async function createCheckoutSession(priceId, successUrl, cancelUrl) {
  const res = await fetch('/api/billing/create-checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priceId, successUrl, cancelUrl }),
    credentials: 'same-origin',
  });
  return res.json();
}

export async function createPortalSession(returnUrl) {
  const res = await fetch('/api/billing/portal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnUrl }),
    credentials: 'same-origin',
  });
  return res.json();
}

export function renderBillingUI() {
  const container = document.getElementById('billing-content');
  if (!container) return;

  container.innerHTML = '<div class="flex justify-center py-12"><div class="animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-500"></div></div>';

  getBillingStatus()
    .then(data => {
      if (data.subscription) {
        renderActiveSubscription(container, data);
      } else {
        renderUpgradeOptions(container);
      }
    })
    .catch(err => {
      if (err.message === 'NOT_AUTHENTICATED') {
        container.innerHTML = `
          <div class="p-6 bg-slate-800 rounded-xl border border-white/5 text-center">
            <p class="text-slate-400 mb-4">Please sign in to view billing details.</p>
            <button onclick="location.reload()" class="px-4 py-2 bg-cyan-600 rounded-lg hover:bg-cyan-500 transition-colors">Sign In</button>
          </div>
        `;
      } else {
        container.innerHTML = `
          <div class="p-6 bg-red-900/30 rounded-xl border border-red-500/30 text-center">
            <p class="text-red-400">Failed to load billing info: ${err.message}</p>
            <button onclick="renderBillingUI()" class="mt-3 px-4 py-2 bg-cyan-600 rounded-lg hover:bg-cyan-500 transition-colors">Retry</button>
          </div>
        `;
      }
    });
}

function renderActiveSubscription(container, data) {
  const sub = data.subscription;
  const ent = data.entitlements;
  const planName = sub.planId.charAt(0).toUpperCase() + sub.planId.slice(1);
  const statusBadge = getStatusBadge(sub.status);
  const renewDate = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString() : 'N/A';
  const isStudent = sub.isStudent ? ' (Student)' : '';

  let featuresHtml = '';
  if (ent) {
    const features = [
      { key: 'council', label: 'AI Council', enabled: ent.features?.council },
      { key: 'councilCritique', label: 'Council Critique', enabled: ent.features?.councilCritique },
      { key: 'advancedAnalytics', label: 'Advanced Analytics', enabled: ent.features?.advancedAnalytics },
    ];
    featuresHtml = features.map(f => `
      <div class="flex items-center justify-between py-2 border-b border-white/5">
        <span class="text-slate-300">${f.label}</span>
        <span class="${f.enabled ? 'text-green-400' : 'text-slate-500'}">
          ${f.enabled ? '✓ Included' : '✗ Not included'}
        </span>
      </div>
    `).join('');
  }

  container.innerHTML = `
    <div class="space-y-6">
      <!-- Current Plan Card -->
      <div class="bg-slate-800 rounded-xl border border-white/5 overflow-hidden">
        <div class="p-6 border-b border-white/5">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-2xl font-bold text-white">${planName}${isStudent}</h3>
              <p class="text-slate-400 mt-1">${statusBadge} • Renews: ${renewDate}</p>
            </div>
            <span class="px-4 py-2 bg-cyan-600/20 text-cyan-400 rounded-full text-lg font-mono">
              $${sub.isStudent ? (PLAN_PRICING[sub.planId]?.studentMonthlyUsd || 0) : (PLAN_PRICING[sub.planId]?.monthlyUsd || 0)}/mo
            </span>
          </div>
        </div>
        <div class="p-6">
          <h4 class="font-semibold text-white mb-4">Plan Features</h4>
          <div class="space-y-2">
            ${featuresHtml}
          </div>
        </div>
      </div>

      <!-- Limits Info -->
      ${ent?.limits ? `
      <div class="bg-slate-800 rounded-xl border border-white/5 p-6">
        <h4 class="font-semibold text-white mb-4">Usage Limits</h4>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
          <div class="bg-slate-700/50 rounded-lg p-4">
            <p class="text-2xl font-bold text-cyan-400">${formatNumber(ent.limits.monthlyInputTokens || 0)}</p>
            <p class="text-xs text-slate-400">Monthly Input Tokens</p>
          </div>
          <div class="bg-slate-700/50 rounded-lg p-4">
            <p class="text-2xl font-bold text-cyan-400">${formatNumber(ent.limits.monthlyOutputTokens || 0)}</p>
            <p class="text-xs text-slate-400">Monthly Output Tokens</p>
          </div>
          <div class="bg-slate-700/50 rounded-lg p-4">
            <p class="text-2xl font-bold text-cyan-400">$${ent.limits.monthlySpendUsd || 0}</p>
            <p class="text-xs text-slate-400">Monthly Spend Limit</p>
          </div>
          <div class="bg-slate-700/50 rounded-lg p-4">
            <p class="text-2xl font-bold text-cyan-400">${ent.limits.councilMaxProviders || 0}</p>
            <p class="text-xs text-slate-400">Max Council Providers</p>
          </div>
        </div>
      </div>
      ` : ''}

      <!-- Manage Button -->
      <div class="flex justify-center">
        <button onclick="manageBilling()" class="px-6 py-3 bg-cyan-600 text-white rounded-lg font-medium hover:bg-cyan-500 transition-colors flex items-center gap-2">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
          Manage Subscription
        </button>
      </div>

      ${sub.cancelAtPeriodEnd ? `
      <div class="p-4 bg-amber-900/30 border border-amber-500/30 rounded-lg">
        <p class="text-amber-300 text-sm">Your subscription will cancel at the end of the current billing period (${renewDate}).</p>
      </div>
      ` : ''}
    </div>
  `;
}

function renderUpgradeOptions(container) {
  const plans = ['pro', 'ultra', 'ultimate'];
  
  container.innerHTML = `
    <div class="space-y-6">
      <div class="text-center">
        <h3 class="text-2xl font-bold text-white mb-2">Upgrade Your Plan</h3>
        <p class="text-slate-400">Unlock AI Council, higher limits, and advanced features</p>
      </div>
      
      <div class="grid md:grid-cols-3 gap-4">
        ${plans.map(planId => {
          const caps = PLAN_CAPABILITIES[planId];
          const name = caps.name;
          const price = caps.pricing.monthlyUsd;
          const studentPrice = caps.pricing.studentMonthlyUsd;
          const features = [
            { label: 'AI Council', enabled: caps.entitlements.council },
            { label: 'Council Critique', enabled: caps.entitlements.councilCritique },
            { label: 'Advanced Analytics', enabled: caps.entitlements.advancedAnalytics },
            { label: `${caps.limits.councilMaxProviders} Council Providers`, enabled: caps.limits.councilMaxProviders > 0 },
            { label: `${formatNumber(caps.limits.monthlyInputTokens)} input tokens/mo`, enabled: true },
            { label: `$${caps.limits.monthlySpendUsd} spend limit/mo`, enabled: true },
          ];
          return `
            <div class="bg-slate-800 rounded-xl border border-white/5 p-6 relative ${planId === 'ultra' ? 'ring-2 ring-cyan-500/50' : ''}">
              ${planId === 'ultra' ? '<div class="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-cyan-600 text-white text-xs font-bold rounded-full">RECOMMENDED</div>' : ''}
              <h4 class="text-xl font-bold text-white mb-2">${name}</h4>
              <div class="mb-4">
                <span class="text-3xl font-bold text-white">$${price}</span>
                <span class="text-slate-400">/month</span>
                ${studentPrice > 0 ? `<br><span class="text-sm text-green-400">Student: $${studentPrice}/mo</span>` : ''}
              </div>
              <ul class="space-y-2 mb-6">
                ${features.map(f => `
                  <li class="flex items-center gap-2 text-sm ${f.enabled ? 'text-slate-300' : 'text-slate-500'}">
                    <svg class="w-4 h-4 ${f.enabled ? 'text-green-400' : 'text-slate-500'} flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      ${f.enabled ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>' : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>'}
                    </svg>
                    ${f.label}
                  </li>
                `).join('')}
              </ul>
              <button onclick="upgradePlan('${planId}')" class="w-full py-3 rounded-lg font-medium transition-colors ${planId === 'ultra' ? 'bg-cyan-600 hover:bg-cyan-500 text-white' : 'bg-slate-700 hover:bg-slate-600 text-white border border-white/10'}">
                Upgrade to ${name}
              </button>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function getStatusBadge(status) {
  const badges = {
    active: '<span class="px-2 py-1 bg-green-500/20 text-green-400 text-xs rounded-full">Active</span>',
    past_due: '<span class="px-2 py-1 bg-amber-500/20 text-amber-400 text-xs rounded-full">Past Due</span>',
    canceled: '<span class="px-2 py-1 bg-red-500/20 text-red-400 text-xs rounded-full">Canceled</span>',
  };
  return badges[status] || `<span class="px-2 py-1 bg-slate-500/20 text-slate-400 text-xs rounded-full">${status}</span>`;
}

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

// Plan pricing for display (matches PLAN_CAPABILITIES)
const PLAN_PRICING = {
  free: { monthlyUsd: 0, studentMonthlyUsd: 0 },
  pro: { monthlyUsd: 10, studentMonthlyUsd: 5 },
  ultra: { monthlyUsd: 50, studentMonthlyUsd: 25 },
  ultimate: { monthlyUsd: 200, studentMonthlyUsd: 100 },
};

// Make functions globally accessible for inline handlers
window.upgradePlan = async function(plan) {
  const priceMap = window.STRIPE_PRICE_MAP || {};
  const priceId = priceMap[plan];
  if (!priceId) {
    alert('Plan not available. Please configure STRIPE_PRICE_ID_MAP in your environment.');
    return;
  }
  const successUrl = window.location.origin + '/billing-success';
  const cancelUrl = window.location.origin + '/billing';
  
  const btn = event.target;
  const originalText = btn.innerHTML;
  btn.innerHTML = '<svg class="animate-spin h-5 w-5" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg> Redirecting...';
  btn.disabled = true;
  
  try {
    const result = await createCheckoutSession(priceId, successUrl, cancelUrl);
    if (result.url) {
      window.location.href = result.url;
    } else {
      alert('Error: ' + (result.error || 'Unknown error'));
      btn.innerHTML = originalText;
      btn.disabled = false;
    }
  } catch (err) {
    alert('Error: ' + err.message);
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
};

window.manageBilling = async function() {
  const returnUrl = window.location.origin + '/billing';
  
  const btn = event.target;
  const originalText = btn.innerHTML;
  btn.innerHTML = '<svg class="animate-spin h-5 w-5" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg> Opening...';
  btn.disabled = true;
  
  try {
    const result = await createPortalSession(returnUrl);
    if (result.url) {
      window.location.href = result.url;
    } else {
      alert('Error: ' + (result.error || 'Unknown error'));
      btn.innerHTML = originalText;
      btn.disabled = false;
    }
  } catch (err) {
    alert('Error: ' + err.message);
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
};

// Auto-initialize if billing view is active
document.addEventListener('DOMContentLoaded', () => {
  const billingView = document.getElementById('view-billing');
  if (billingView && !billingView.classList.contains('hidden')) {
    renderBillingUI();
  }
});

// Listen for view changes
const observer = new MutationObserver((mutations) => {
  mutations.forEach(mutation => {
    if (mutation.target.id === 'view-billing' && !mutation.target.classList.contains('hidden')) {
      renderBillingUI();
    }
  });
});

observer.observe(document.getElementById('view-billing') || document.body, { 
  attributes: true, 
  attributeFilter: ['class'] 
});

export { PLAN_CAPABILITIES };