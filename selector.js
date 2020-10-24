
import {AppElement, html} from '@smyd/app-shared/app-element.js';
import htmlString from './selector.html';
import {schedule} from '@smyd/app-functions/utils.js';
import '@smyd/app-overlays/app-header-overlay.js';
import '@smyd/app-shared/app-icons.js';
import '@polymer/iron-icon/iron-icon.js';
import '@polymer/paper-button/paper-button.js';


class CheckoutSelector extends AppElement {
  static get is() { return 'checkout-selector'; }

  static get template() {
    return html([htmlString]);
  }


  static get properties() {
    return {
      // hidden attribute in html
      hasShippables: Boolean

    };
  }


  async __selectorBtnClicked(orderType) {
    try {
      await this.clicked();
      this.fire('selector-order-type-selected', {orderType});
    }
    catch (error) { 
      if (error === 'click debounced') { return; }
      console.error(error); 
    }
  }


  __onlinePayShipBtnClicked() {
    this.__selectorBtnClicked('ship');
  }


  __onlinePayInStorePickupBtnClicked() {
    this.__selectorBtnClicked('prepaid');
  }


  __inStorePayPickupBtnClicked() {
    this.__selectorBtnClicked('pickup');
  }


  __onlinePayBtnClicked() {
    this.__selectorBtnClicked('prepaid');
  }


  __inStorePayBtnClicked() {
    this.__selectorBtnClicked('pickup');
  }


  open() {
    return this.$.overlay.open();
  }
  

  reset() {
    return this.$.overlay.reset();
  }

}

window.customElements.define(CheckoutSelector.is, CheckoutSelector);
