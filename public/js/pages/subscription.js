
import { initPage } from '../shell.js';

// Initialize the subscription page and navigation.
await initPage({ active: 'subscription' });

// Demo subscription prices. No payment processing or backend calls.
const plans = {
  free: { monthly: 0, yearly: 0 },
  pro: { monthly: 9, yearly: 90 },
  'pro-max': { monthly: 19, yearly: 190 },
};

const monthlyButton = document.getElementById('billing-monthly');
const yearlyButton = document.getElementById('billing-yearly');

// Update displayed plan prices and billing period.
function updateBilling(period) {
  const isYearly = period === 'yearly';

  for (const [plan, prices] of Object.entries(plans)) {
    const priceElement = document.getElementById(`price-${plan}`);
    const periodElement = document.getElementById(`period-${plan}`);

    priceElement.textContent = `€${prices[period]}`;
    periodElement.textContent = isYearly ? '/ year' : '/ month';
  }

  // Keep the buttons visually and accessibly synchronized.
  monthlyButton.classList.toggle('is-active', !isYearly);
  yearlyButton.classList.toggle('is-active', isYearly);

  monthlyButton.setAttribute('aria-pressed', String(!isYearly));
  yearlyButton.setAttribute('aria-pressed', String(isYearly));
}

// Switch between monthly and yearly demo pricing.
monthlyButton.addEventListener('click', () => {
  updateBilling('monthly');
});

yearlyButton.addEventListener('click', () => {
  updateBilling('yearly');
});

// Start with Monthly selected.
updateBilling('monthly');
