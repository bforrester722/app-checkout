
import {AppElement, html} from '@smyd/app-shared/app-element.js';
import {
  compose,
  currency,
  join, 
  map, 
  split
}                 from '@smyd/app-functions/lambda.js';
import {
  isDisplayed,
  listen, 
  schedule, 
  wait, 
  warn
}                 from '@smyd/app-functions/utils.js';
import {
  freeShippingThreshold
}                 from 'app.config.js';
import services   from '@smyd/app-functions/services.js';
import htmlString from './info.html';
import '@smyd/app-overlays/app-header-overlay.js';
import '@smyd/app-overlays/app-modal.js';
import '@smyd/app-shared/app-icons.js';
import '@smyd/app-overlays/app-spinner.js';
import '@smyd/app-inputs/edit-input.js';
import '@smyd/app-inputs/shipping-inputs.js';
import '@polymer/paper-button/paper-button.js';
import '@polymer/paper-checkbox/paper-checkbox.js';
import '@polymer/paper-radio-group/paper-radio-group.js';
import '@polymer/paper-radio-button/paper-radio-button.js';
import '@polymer/paper-icon-button/paper-icon-button.js';
import '@polymer/paper-input/paper-input.js';


const trim                = str => str.trim();
const toLower             = str => str.toLowerCase();
const removeSpacesAndCaps = compose(trim, split(' '), map(toLower), join(''));


class CheckoutInfo extends AppElement {
  static get is() { return 'checkout-info'; }

  static get template() {
    return html([htmlString]);
  }

  static get properties() {
    return {

      hasShippables: Boolean,

      orderType: String,

      shippables: Array,
      // used for free shipping threshold
      subtotal: Number,

      user: Object,

      userData: Object,

      _addressErrorMessages: Array,
      // paper-checkbox state
      _defaultShippingAddressChecked: Boolean,

      _info: {
        type: Object,
        computed: '__computeInfo(_verifiedAddress, _orderUserInfo.email, _orderUserInfo.fullName, orderType, _selectedRate.rateObjectIds, _selectedRate.total)'
      },

      _orderUserInfo: {
        type: Object,
        value: () => ({
          email:    '',
          fullName: '',
          address1: '', 
          address2: '',
          city:     '',
          state:    '',
          zip:      '',
          country:  ''
        })
      },
      // checkbox value that only changes due to human interaction
      _saveShippingToUserData: Boolean,
      // value set to force computed bindings to run
      _selectedRate: {
        type: Object,
        value: () => ({})
      },
      // rates returned by shippo for user to choose from
      _shippingRates: Array,

      _shippingSelected: Boolean,
      // verified and formatted address that is returned by shippo
      _verifiedAddress: Object

    };
  }


  static get observers() {
    return [
      '__currentUserChanged(user, userData)',
      '__infoChanged(_info.*)'
    ];
  }


  connectedCallback() {
    super.connectedCallback();

    listen(this, 'edit-input-changed', this.__inputChanged.bind(this));
  }


  __computeShippingInputsHidden(hasShippables, orderType) {
    if (orderType !== 'ship') { return true; }
    return !hasShippables;
  }


  __computeAnonymousUserContent(user) {
    return Boolean(user);
  }


  __computeFullNamePlaceholder(displayName) {
    return displayName ? displayName : 'No full name';
  }


  __computeEmailPlaceholder(email) {
    return email ? email : 'No email';
  }


  __computeEmailLabel(verified) {
    return verified ? 'Email Verified' : 'Email';
  }


  __computeButtonsDisabled(userInfo, orderType) {
    // use a truthy value for address2 since it is not required
    if (!userInfo.base) { return true; }
    // only these props need to be tested
    const {address1, city, country, email, fullName, state, zip} = userInfo.base;
    const propsToTest = orderType === 'ship' ? 
                          {address1, city, country, email, fullName, state, zip} :
                          {email, fullName};
    const values  = Object.values(propsToTest);
    const strings = values.filter(val => typeof val === 'string');
    return strings.some(str => !str.trim()); // no empty spaces
  }


  __computeConfirmBtnDisabled(selected) {
    return !Boolean(selected.rateObjectIds);
  }


  __computeRateTotal(total) {
    return total > 0 ? `$${currency(total)}` : 'Free Shipping';
  }


  __computeEstimatedDays(estimated) {
    return estimated > 1 ? `${estimated} days` : `${estimated} day`;
  }


  __computeInfo(address, email, fullName, orderType, rateIds, shippingCost) {
    const normalizedFullName = fullName ? removeSpacesAndCaps(fullName) : '';
    const normalizedEmail    = email    ? removeSpacesAndCaps(email)    : '';
    if (orderType === 'ship') {
      return {
        address, 
        email, 
        fullName, 
        normalizedFullName,
        normalizedEmail,
        rateIds, 
        shippingCost
      };
    }
    return {
      address, 
      email, 
      fullName, 
      normalizedFullName,
      normalizedEmail
    };  
  }


  __showSpinner(message) {
    return this.$.spinner.show(message);
  }


  __hideSpinner() {
    return this.$.spinner.hide();
  }


  async __currentUserChanged(user, userData) {
    try {
      // userData is undefined until the cloud has created the doc
      // for users who choose signup when prompted in checkout flow.
      if (user && user.uid && userData) {
        // MUST wait for 'edit-input-changed' events to complete
        // since they initialize as empty strings for each
        // property of _orderUserInfo and overwrite incoming
        // user and userData props
        await schedule();
        // fixes a bug where the spinner promise will hang when its parent
        // is not displayed
        // this happens when the user opens checkout, closes auth modal,
        // then backs out to home to log in
        if (isDisplayed(this.$.overlay)) { 
          await this.__showSpinner('Fetching your account information.');
        }

        if (userData.address1) {
          this._defaultShippingAddressChecked = true;
        }
        this._orderUserInfo = Object.assign(
          {}, 
          this._orderUserInfo, 
          userData, 
          {email: user.email, uid: user.uid, fullName: user.displayName}
        );
      }
    }
    catch (error) {
      await this.__cloudFunctionErrorHandler(error);
    }
    finally {
      this.__hideSpinner();
    }
  }


  __inputChanged(event) {
    const {kind, value} = event.detail;
    this.set(`_orderUserInfo.${kind}`, value.trim());
    this._defaultShippingAddressChecked = false;
  }


  __infoChanged(obj) {
    if (!obj || !obj.base) { return; }
    const {base: info} = obj;
    this.fire('info-changed', {info});
  }


  __cloudFunctionErrorHandler(error, warning = 'Sorry, an unexpected error occured. Please try again.') {
    if (error === 'click debounced') { return; }
    console.error(error);
    if (window.navigator.onLine) {
      return warn(warning);
    }
    else {
      return warn('Please check your internet connection.');
    }
  }


  async __accountButtonClicked() {
    try {
      await this.clicked();
      await this.$.authModal.close();
      this.fire('info-account-btn-clicked');
    }
    catch (error) { 
      if (error === 'click debounced') { return; }
      console.error(error); 
    }
  }


  async __saveAsDefaultShippingButtonClicked() {
    try {
      await this.clicked();
      this._saveShippingToUserData = this.$.checkbox.checked;
    }
    catch (error) { 
      if (error === 'click debounced') { return; }
      console.error(error);
    }
  }
  
  
  async __shippingOptionsButtonClicked() {
    try {
      await this.clicked();
      await this.__showSpinner('Calculating shipping options');
      const {fullName, address1, address2} = this._orderUserInfo;
      // format address for shippo
      const address = Object.assign(
        {}, 
        this._orderUserInfo, 
        {name: fullName, street1: address1, street2: address2}
      );

      const {address_to, rates, messages} = 
        await services.cloudFunction({
          name: 'getShippingRates', 
          data: {address, items: this.shippables}
        });


      if (this._saveShippingToUserData) {
        // save to user's doc
        await services.set({coll: 'users', doc: this.user.uid, data: this._orderUserInfo});
      }

      if (Array.isArray(rates)) {
        if (this.subtotal > freeShippingThreshold) { // app.config.js
          const [lowest, ...rest] = rates;
          const freeShippingRate  = Object.assign({}, lowest, {total: 0});
          this._shippingRates     = [freeShippingRate, ...rest];
        }
        else {
          this._shippingRates = rates;
        }
        this._verifiedAddress = address_to;
        await schedule();
        await this.$.shippingModal.open();
      }
      else if (messages) { // did not pass shippo's address verification
        this._shippingRates        = undefined;
        this._verifiedAddress      = undefined;
        this._addressErrorMessages = messages;
        await schedule();
        await this.$.addressErrorModal.open();
      }
      else {
        throw new Error('getShippingRates unexpected error with no error messages present');
      }
    }
    catch (error) { 
      await this.__cloudFunctionErrorHandler(error);
    }
    finally {      
      this.__hideSpinner();
    }
  }  


  async __addressErrorModalDismissButtonClicked() {
    try {
      await this.clicked();
      this.$.addressErrorModal.close();
    }
    catch (error) { 
      if (error === 'click debounced') { return; }
      console.error(error); 
    }
  }


  async __selectedRadioButtonChanged(event) {
    try {
      await this.clicked();
      const {value} = event.detail;
      this._selectedRate = 
        this._shippingRates.find(rate => rate.name === value);
    }
    catch (error) { 
      if (error === 'click debounced') { return; }
      console.error(error); 
    }
  }


  async __modalDismissButtonClicked() {
    try {
      await this.clicked();
      this.$.shippingModal.close();
    }
    catch (error) { 
      if (error === 'click debounced') { return; }
      console.error(error); 
    }  
  }


  async __authModalContinueButtonClicked() {
    try {
      await this.clicked();
      this.$.authModal.close();
    }
    catch (error) { 
      if (error === 'click debounced') { return; }
      console.error(error); 
    }
  }


  async __modalConfirmButtonClicked() {
    try {
      await this.clicked();
      this.fire('info-shipping-rate-selected');
    }
    catch (error) { 
      if (error === 'click debounced') { return; }
      console.error(error); 
    }
  }


  async __continueButtonClicked() {
    try {
      await this.clicked();
      this.fire('info-email-verified');
    }
    catch (error) { 
      if (error === 'click debounced') { return; }
      console.error(error);
    }
  }


  resetShippingModal() {
    this.$.shippingModal.reset();
  }


  async closeModals() {
    const promises = [
      this.$.authModal.close(),
      this.$.addressErrorModal.close(),
      this.$.shippingModal.close()
    ];
    return Promise.all(promises);
  }


  async open() {
    try {
      await this.$.overlay.open();
      if (!this.user) {
        await  schedule();
        return this.$.authModal.open();
      }
    }
    catch (error) { console.log('checkout-info open error: ', error); }
  }


  reset() {
    this.resetShippingModal();
    this.$.authModal.reset();
    this.$.overlay.reset();
  }

}

window.customElements.define(CheckoutInfo.is, CheckoutInfo);
