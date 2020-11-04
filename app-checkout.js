/**
  *
  *
  *
  * Properties:
  *
  *   passthrough: Object ({items, ...}) 
  *     'items' is the only required prop, all others get passed through to 'pay' cloud func
  *      Each item requires 'amount' and 'orderQty' props 
  *      'amount' needs to be a string toFixed(2)
  *      'orderQty' is an int
  *
  *
  *   subscriptions: Array 
  *     for each cart item that should receive live price/qty updates
  *     Sub items that have qty paths will automatically have their inventory adjusted after the sale
  *
  *     example usage:
  *
  *     const cardSubs = cards.base.map(card => {
          const {condition, foil} = card.selected;
          const foilStr           = makeFoilStr(foil);
          const {price, sale}     = card[foilStr][condition];
          const basePath          = `${foilStr}.${condition}`;
          const pricePath         = Number(sale) ? 
                                      `${basePath}.sale` : 
                                      `${basePath}.price`;
          const dbQtyPath         = `${basePath}.qty`;                           
          const qtyPath           = `${basePath}.cartQty`;

          const cardSub = {
            coll:         'cms/inventory/cards',
            dbPricePaths: [pricePath],
            dbQtyPaths:   [dbQtyPath],
            docProp:      'id',
            item:         card,
            matcher:      cardMatcher,
            pricePaths:   [pricePath],
            qtyPaths:     [qtyPath],
            type:         'cards' // becomes prop in changes obj for events
          };
          return cardSub;
        });

        const eventSubs = events.base.map(event => {
          const eventSub = {
            coll:         'cms/ui/events',
            dbPricePaths: [],
            dbQtyPaths:   ['seats'],
            docProp:      'name',
            item:         event,
            matcher:      eventsMatcher,
            pricePaths:   [],
            qtyPaths:     ['cartQty'],
            type:         'events' // becomes prop in changes obj for events
          };
          return eventSub;
        });

        const customItemSubs = customItems.base.map(item => {
          const itemSub = {
            coll:         'cms/inventory/items',
            dbPricePaths: ['price'],
            dbQtyPaths:   ['qty'],
            docProp:      'normalized',
            item,
            matcher:      itemsMatcher,
            pricePaths:   ['price'],
            qtyPaths:     ['cartQty'],
            type:         'customItems' // becomes prop in changes obj for events
          };
          return itemSub;
        });
        // set spriteful-checkout subscriptions prop
        this._itemsSyncSubscriptions = [...cardSubs, ...eventSubs, ...customItemSubs];
  *
  *
  *
  *
  *   taxRate: Number
  *     default is TX at 8.25%
  *
  *
  *
  *
  * Public Methods:
  *
  *   open() 
  *     Must pass an object with at least the following props. 
  *     Extra props will be passed through to 'pay' cloud function
  *
  *     user           = null,  // firebase currentUser
  *     items          = [],    // all items
  *     shippableItems = [],    // only shippable items
  *     subtotal       = 0      // sum of all items individual prices, no tax or shipping
  *
  *
  *   syncChanges(matcher, items, changes)
  *     Pass in a matcher function that can guarantee 
  *     uniqueness amongst items and changes being passed in.
  *     Will update based on the subscrptions dbPaths and paths.
  *     Items with quantity changes will have a 
  *     'quantityChanged' boolean set on them, which will be true
  *     when db qtys are lower than selected/in cart qtys
  *   
  *
  *
  * Events:
  *
  *   'checkout-in-store-pay' must be handled by app specific logic
  *
  *
  *   'checkout-in-store-pay-pickup' must be handled by app specific logic
  *
  *
  *   'checkout-success-overlay-opened' use this to reset cart
  *
  *
  **/


import {AppElement, html} from '@smyd/app-shared/app-element.js';
import {
  listen, 
  schedule,
  warn
}                 from '@smyd/app-functions/utils.js';
import {currency} from '@smyd/app-functions/lambda.js';
import services   from '@smyd/app-functions/services.js';
import htmlString from './app-checkout.html';
import '@smyd/app-overlays/app-spinner.js';
import './selector.js';


const makeInt = numOrStr => 
  numOrStr === undefined ? 0 : Number(numOrStr) * 100;

const makeCurrencyFloat = num => num / 100;


const applicableTaxes = (state, orderType, taxes) => {
  if (orderType === 'ship') {
    if (state && state.toUpperCase() === 'TX') {
      return taxes;
    }
    return '0.00'; // only out of state orders are tax free
  }
  return taxes; // pickups and prepaids are in state, duh
};


const getTotal = (credit, tax, subtotal, shipping, orderType ) => {
  if (orderType === 'pickup') {
    return makeInt(subtotal) + makeInt(tax) + makeInt(shipping);
  }
  return (makeInt(subtotal) + makeInt(tax) + makeInt(shipping));
  // return (makeInt(subtotal) + makeInt(tax) + makeInt(shipping)) - makeInt(credit);
};

const getTot = (credit, tax, subtotal, shipping, orderType) => {
  const totInt = getTotal(credit, tax, subtotal, shipping, orderType);
  const tot    = totInt > 0 ? makeCurrencyFloat(totInt) : 0;
  return currency(tot);
};
// build an object formatted to be used by spriteful-pay
// required: email, items, rateIds, subtotal, total, tax, user
// do not tax items being sold outside of texas
const addTaxAndTotal = (invoice, orderType, taxIfApplicable) => {
  const {
    address      = {},
    credit       = '0.00',
    shippingCost = 0, 
    subtotal
  }             = invoice;
  const {state} = address;  
  const tax     = applicableTaxes(state, orderType, taxIfApplicable);
  const total   = getTot(credit, tax, subtotal, shippingCost, orderType);
  const order   = Object.assign(
    {}, 
    invoice, 
    {tax, total}
  );
  return order;
};


const checkCreditVsTotal = order => {
  const {credit, total} = order;
  return makeInt(credit) >= makeInt(total);
};


class AppCheckout extends AppElement {
  static get is() { return 'app-checkout'; }

  static get template() {
    return html([htmlString]);
  }

  static get properties() {
    return {   
      // pass through data to cloud func
      // must include items, which is all sold items
      // all other cartData props will be passed through to 'pay' cloud function
      passthrough: Object, // {items: [itemObj1, itemObj2, ...]}
      // checkout items subtotal before taxes, and shipping
      subtotal: Number,
      // for checkout-items-sync
      subscriptions: Array,



      // TODO:
      //      make a generic way to calculate taxes from inside checkout
      //      using current subscriptions mechanism will not work
      //      for digital goods, which are taxed but not necessarily 
      //      subscribed to for price/qty chages


      // temporary ASG app specific impl
      taxIfApplicable: Number,





      taxRate: {
        type: Number,
        value: 8.25 // Texas tax rate
      },
      // firebase currentUser
      user: Object,
      // spriteful-items-sync prop
      // determines whether to show modal
      // or fire change notification events
      _checkoutOpen: {
        type: Boolean,
        value: false
      },
      // user store credit
      _credit: String,

      _hasShippables: {
        type: Boolean,
        computed: '__computeHasShippables(_shippables)'
      },
      // passed up from info.js
      _info: Object,
      // from spriteful-items-sync
      // 'pay' cloud function --> 'completeOrder' triggered cloud function --> adjustInventory function
      // extracted from subscriptions
      _inventoryAdjustments: Array,

      _order: {
        type: Object,
        computed: '__computeOrder(_info, _inventoryAdjustments, _orderType, passthrough, subtotal, taxIfApplicable, user, _credit)'
      },

      _orderType: String,
      // only shippable items, those with amount, description, displayName, shipping obj, etc.
      _shippables: {
        type: Array,
        computed: '__computeShippables(passthrough.items)'
      },
      // same as subscriptions, but set after the 
      // spriteful-items-sync module has been imported
      _syncSubscriptions: Array,
      // set by handler of 'spriteful-pay-too-late-to-close' event
      // must stop sync from opening if user is in middle of paying
      _tooLateToOpenSync: Boolean,

      _unsubscribeCredit: Object,

      _unsubscribeUser: Object,

      _userData: Object

    };
  }


  static get observers() {
    return [
      '__subscriptionsChanged(subscriptions)',
      '__userChanged(user)'
    ];
  }


  connectedCallback() {
    super.connectedCallback();

    listen(this.$.selector, 'overlay-reset',      this.__selectorClosed.bind(this));
    listen(this, 'selector-order-type-selected',  this.__openInfo.bind(this));
    listen(this, 'info-changed',                  this.__infoChanged.bind(this));
    listen(this, 'info-email-verified',           this.__openOrder.bind(this));
    listen(this, 'info-shipping-rate-selected',   this.__openOrder.bind(this));
    listen(this, 'info-account-btn-clicked',      this.__showUserUI.bind(this));
    listen(this, 'order-place-order-btn-clicked', this.__placeOrder.bind(this));
    listen(this, 'success-closing',               this.__closeOrder.bind(this));
    listen(this, 'pay-too-late-to-close',         this.__tooLateToOpenSync.bind(this));
    listen(this, 'pay-open-sync',                 this.__openSyncModal.bind(this));
    listen(this, 'pay-success',                   this.__paySuccess.bind(this));
    listen(this, 'items-sync-close-pay',          this.__closePay.bind(this));
    listen(this, 'items-sync-close-modals',       this.__closeModals.bind(this));       
    listen(this, 'items-sync-proceed',            this.__proceedWithChanges.bind(this));       
    listen(this, 'items-sync-edit-cart',          this.__editCart.bind(this));
    listen(this, 'items-sync-cancel-order',       this.__cancelOrder.bind(this));    
    listen(this, 'items-sync-update-slotted',     this.__syncUpdateSlotted.bind(this));
    listen(this, 'items-sync-changes',            this.__syncItemChanges.bind(this)); 
    listen(this, 'items-sync-adjustments',        this.__syncInventoryAdjustments.bind(this));
  }

  // items that include a shipping object
  __computeShippables(items) {
    if (!items) { return; }
    return items.filter(item => item.shipping);
  }


  __computeHasShippables(shippables) {
    return shippables && shippables.length;
  }


  __computeOrder(info, inventoryAdjustments, orderType, passthrough, subtotal, taxIfApplicable, user, credit) {
    if(!info || !orderType || !passthrough || !subtotal || !taxIfApplicable) { return; }
    
    // capture user's timezone aware time, server adds server 'timestamp' to order
    const date    = new Date(Date.now()).toLocaleString(); 
    const invoice = Object.assign(
      {}, 
      passthrough, 
      info,
      {credit, date, inventoryAdjustments, orderType, subtotal, user}
    );
    return addTaxAndTotal(invoice, orderType, taxIfApplicable);
  }


  async __subscriptionsChanged(subs) {
    if (subs) {
      await import(
        /* webpackChunkName: 'checkout-items-sync' */
        '@smyd/checkout-items-sync/checkout-items-sync.js'
      );
    }
    this._syncSubscriptions = subs;
  }


  async __startUserSub(uid) {
    const callback = dbVal => {
      this._userData = dbVal;
    };

    const errorCallback = error => {
      this._userData = undefined;
      if (
        error.message && 
        error.message.includes('document does not exist')
      ) { return; }
      console.error(error);
    };

    this._unsubscribeUser = await services.subscribe({
      callback,
      coll: 'users',
      doc:   uid,
      errorCallback
    });
  }


  async __startCreditSub(uid) {
    const callback = dbVal => {
      this._credit = dbVal.credit;
    };

    const errorCallback = error => {
      this._credit = undefined;
      if (error.message === 'document does not exist') { return; }
      console.error(error);
    };

    this._unsubscribeCredit = await services.subscribe({
      callback,
      coll: `users/${uid}/credit`,
      doc:  'asg',
      errorCallback
    });
  }

  // pull user data from db
  __userChanged(user) {
    if (user) {
      const {uid} = user;
      this.__startUserSub(uid);
      this.__startCreditSub(uid);
    }
    else {
      if (this._unsubscribeCredit) {
        this._unsubscribeCredit();
        this._unsubscribeUser();
        this._unsubscribeCredit = undefined;
        this._unsubscribeUser   = undefined;
      }
    }
  }


  __infoChanged(event) {
    this._info = event.detail.info;
  }


  async __openInfo(event) {
    this._orderType = event.detail.orderType;
    await import(
      /* webpackChunkName: 'checkout-info' */ 
      './info.js'
    );
    this.$.info.open();
  }


  async __openOrder() { 
    try {
      await import(
        /* webpackChunkName: 'checkout-order' */ 
        './order.js'
      );
      await this.$.order.open();
      this.$.info.resetShippingModal();
    }
    catch (error) { console.log('__openOrder error: ', error); }
  }


  __showUserUI() {
    // app-shell listens for this event
    this.fire('show-user-ui');
  }


  __cloudFunctionErrorHandler(error, warning = 'Sorry, an unexpected error occured. Please try again.') {
    if (error === 'click debounced') { return; }
      this.fire('save-error', {error, data: this._order, func: 'app-checkout__cloudFunctionErrorHandler'});
      console.error(error);
    if (window.navigator.onLine) {
      return warn(warning);
    }
    else {
      return warn('Please check your internet connection.');
    }
  }
  // pickup orders bypass pay and do not have inventory adjusted
  // must rename order.inventoryAdjustments to order.pickupInventoryAdjustments
  async __handlePickupOrder() {
    try {
      await this.$.spinner.show('Sending your order to the store.');
      const {email, inventoryAdjustments, total} = this._order;
      const uid = this.user ? this.user.uid : 'anonymous';
      const pickupOrder = Object.assign(
        {}, 
        this._order,
        {
          amount: total,
          // dont automatically adjust inventory
          inventoryAdjustments: null, // firebase does not like undefined
          // rename, adjustments happen when customer actually picks up the order         
          pickupInventoryAdjustments: inventoryAdjustments,
          uid,
          user: null // firebase does not like undefined
        }
      );
      await services.cloudFunction({
        data:  pickupOrder, 
        name: 'savePickupOrder'
      });
      await this.__openSuccess(email);
    }
    catch (error) {      
      await this.__cloudFunctionErrorHandler(error); 
    }    
    finally {
      this.$.spinner.hide();
    }
  }
  // bypass opening checkout-pay if users store credit
  // is enough to pay for the entire order
  // async __handleCreditOrder() {
  //   try {
  //     await this.$.spinner.show('Processing');
  //     const {email, inventoryAdjustments, total} = this._order;
  //     const uid = this.user ? this.user.uid : 'anonymous';
  //     const creditOrder = Object.assign(
  //       {}, 
  //       this._order,
  //       {
  //         amount: total,
  //         uid,
  //         user: null // firebase does not like undefined
  //       }
  //     );
  //     await services.cloudFunction({
  //       data:  creditOrder, 
  //       name: 'pay'
  //     });
  //     await this.__openSuccess(email);
  //   }
  //   catch (error) {      
  //     await this.__cloudFunctionErrorHandler(error); 
  //   }    
  //   finally {
  //     this.$.spinner.hide();
  //   }
  // }


  async __placeOrder() {
    try { 
      if (this._order.orderType === 'pickup') {
        return this.__handlePickupOrder();
      }
      // commented out not working correctly
      // const creditCoversTotal = checkCreditVsTotal(this._order);
      // if (creditCoversTotal) {
      //   return this.__handleCreditOrder();
      // }

      await import(
        /* webpackChunkName: 'checkout-pay' */ 
        '@smyd/checkout-pay/checkout-pay.js'
      );
      this.$.pay.open();
    }
    catch (error) {
      this.fire('save-error', {error, data: this._order, func: 'app-checkout__placeOrder'});
      console.error(error);
    }
  }

  // from spriteful-pay when db validation errors occur
  __openSyncModal() {
    this.$.sync.openModal();
  }

  
  async __openSuccess(email) {
    await import(
      /* webpackChunkName: 'checkout-success' */ 
      './success.js'
    );
    await this.$.success.open(email);
    // used to reset cart
    this.fire('checkout-success-opened');
  }


  __paySuccess(event) {    
    const {email} = event.detail;
    this.__openSuccess(email);
  }


  __closeOrder() {
    this.$.order.close();
  }


  __selectorClosed() {
    this._checkoutOpen = false;
  }

  // do not open sync modal if user is in final pay sequence
  __tooLateToOpenSync(event) {
    this._tooLateToOpenSync = event.detail.tooLate;
  }

  // close pay if there are any late price or availability changes
  __closePay() {
    if (!this.$.pay.close) { return; } // has not been imported/opened yet
    return this.$.pay.close();
  }

  // checkout-items-sync event
  __closeModals() {
    if (this.$.info.closeModals) {
      this.$.info.closeModals();
    }
  }

  // items-sync edit order or cancel order
  __resetAll() {
    if (this.$.order.reset) { // has been imported
      this.$.order.reset();
    }
    if (this.$.info.reset) { // has been imported
      this.$.info.reset();
    }
    this.$.selector.reset();
  }
  // only called when checkout is open
  // rename event
  __proceedWithChanges(event) {
    // pay has already been closed by this point
    // if there are qty changes, move user back to 
    // info view so shipping can be recalculated
    const {qtyChanges, synced} = event.detail;
    if (qtyChanges) {
      if (this.$.order.reset) { // has been imported
        this.$.order.reset();
      }
    }      
    this.fire('checkout-proceed', synced);
  }
  // only called when checkout is open
  // rename event
  __editCart(event) {
    this.__resetAll();
    this.fire('checkout-edit-cart', event.detail.synced);
  }
  // only called when checkout is open
  // rename event
  __cancelOrder(event) {
    this.__resetAll();
    this.fire('checkout-cancel-order', event.detail.synced);
  }

  // rename event
  __syncUpdateSlotted(event) {
    this.fire('checkout-sync-slotted', event.detail);
  }

  // rename event
  __syncItemChanges(event) {
    this.fire('checkout-changes', event.detail);
  }


  __syncInventoryAdjustments(event) {
    this._inventoryAdjustments = event.detail.adjustments;
  }
  // pass subscribed items in
  // returns items updated with changes
  syncChanges(...args) {
    return this.$.sync.syncChanges(...args);
  }

  
  open() {
    this._checkoutOpen = true;
    return this.$.selector.open();
  }

}

window.customElements.define(AppCheckout.is, AppCheckout);
