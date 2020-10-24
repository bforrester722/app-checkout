
import {AppElement, html} from '@smyd/app-shared/app-element.js';
import {schedule}  from '@smyd/app-functions/utils.js';
import {
  privacyPolicyUrl,
  termsOfServiceUrl
}                  from 'app.config.js';
import htmlString  from './order.html';
import '@smyd/app-overlays/app-header-overlay.js';
import '@polymer/paper-button/paper-button.js';
import '@polymer/paper-checkbox/paper-checkbox.js';


class CheckoutOrder extends AppElement {
  static get is() { return 'checkout-order'; }

  static get template() {
    return html([htmlString]);
  }
  

  static get properties() {
    return {

      order: Object,

      _hideCredit: {
        type: Boolean,
        computed: '__computeHideCredit(order.credit, order.orderType)'
      },

      _hideShipping: {
        type: Boolean,
        computed: '__computeHideShipping(order.shippingCost)'
      },
      // disabled until user checks the privacy and terms checkbox
      _orderBtnDisabled: {
        type: Boolean,
        value: true
      },
      // privacy policy url for paper-checkbox
      _privacyUrl: String,
      // terms of service url for paper-checkbox
      _termsUrl: String

    };
  }


  connectedCallback() {
    super.connectedCallback();

    this._privacyUrl = privacyPolicyUrl;
    this._termsUrl   = termsOfServiceUrl;
  }


  __computeHideShipping(num) {
    return num === undefined ? true : false;
  }


  __computeHideCredit(str, type) {
    return str === undefined || str === '0.00' || type === 'pickup' ? true : false;
  }


  __computeFormattedShippingCost(num) {
    return num === 0 ? 'Free Shipping' : `$${num}`;
  }
  // privacy and terms checkbox on-checked-changed handler
  // user has agreed to privacy policy and terms of service
  __privacyTermsCheckedChanged(event) {
    // enable order button when checkbox is checked
    this._orderBtnDisabled = !event.detail.value;
  }


  async __placeOrderButtonClicked() {
    try {
      await this.clicked();
      this.fire('order-place-order-btn-clicked');
    }
    catch (error) { 
      if (error === 'click debounced') { return; }
      console.log('__placeOrderButtonClicked error: ', error); 
    }
  }
  

  async close() {
    await this.$.overlay.close();
    this.style.display = 'none';
  }


  async open() {
    this.style.display = 'block';
    await schedule();
    return this.$.overlay.open();
  }
  

  reset() {
    this.$.overlay.reset();
    this.style.display = 'none';
  }

}

window.customElements.define(CheckoutOrder.is, CheckoutOrder);
