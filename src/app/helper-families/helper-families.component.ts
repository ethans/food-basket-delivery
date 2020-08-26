import { Component, OnInit, Input, ViewChild, Output, EventEmitter, ElementRef } from '@angular/core';
import { BusyService, ServerFunction, StringColumn, GridButton, BoolColumn, ServerContext } from '@remult/core';
import * as copy from 'copy-to-clipboard';
import { UserFamiliesList } from '../my-families/user-families';
import { MapComponent } from '../map/map.component';

import { DeliveryStatus } from "../families/DeliveryStatus";
import { AuthService } from '../auth/auth-service';
import { DialogService } from '../select-popup/dialog';
import { SendSmsAction, SendSmsUtils } from '../asign-family/send-sms-action';

import { ApplicationSettings, getSettings } from '../manage/ApplicationSettings';
import { Context } from '@remult/core';
import { Column } from '@remult/core';
import { use, TranslationOptions } from '../translate';
import { Helpers, HelperId, HelpersBase } from '../helpers/helpers';
import { GetVolunteerFeedback } from '../update-comment/update-comment.component';
import { CommonQuestionsComponent } from '../common-questions/common-questions.component';
import { ActiveFamilyDeliveries } from '../families/FamilyDeliveries';
import { isGpsAddress, Location, toLongLat, GetDistanceBetween } from '../shared/googleApiHelpers';
import { Roles } from '../auth/roles';
import { pagedRowsIterator } from '../families/familyActionsWiring';
import { Families } from '../families/families';
import { MatTabGroup } from '@angular/material';
import { routeStrategyColumn } from '../asign-family/route-strategy';
import { InputAreaComponent } from '../select-popup/input-area/input-area.component';
import { PhoneColumn } from '../model-shared/types';
import { Sites, getLang } from '../sites/sites';
import { SelectListComponent, selectListItem } from '../select-list/select-list.component';
import { lang } from 'moment';
import { EditCommentDialogComponent } from '../edit-comment-dialog/edit-comment-dialog.component';
import { SelectHelperComponent } from '../select-helper/select-helper.component';
import { AsignFamilyComponent } from '../asign-family/asign-family.component';
import { HelperAssignmentComponent } from '../helper-assignment/helper-assignment.component';
import { PromiseThrottle } from '../shared/utils';
import { moveDeliveriesHelper } from './move-deliveries-helper';


@Component({
  selector: 'app-helper-families',
  templateUrl: './helper-families.component.html',
  styleUrls: ['./helper-families.component.scss']
})
export class HelperFamiliesComponent implements OnInit {
  switchToMap() {
    this.tab.selectedIndex = 1;
  }

  constructor(public auth: AuthService, private dialog: DialogService, public context: Context, private busy: BusyService, public settings: ApplicationSettings) { }
  @Input() familyLists: UserFamiliesList;
  @Input() partOfAssign = false;
  @Input() partOfReview = false;
  @Input() helperGotSms = false;
  @Output() assignmentCanceled = new EventEmitter<void>();
  @Output() assignSmsSent = new EventEmitter<void>();
  @Input() preview = false;
  @ViewChild("theTab", { static: false }) tab: MatTabGroup;
  ngOnInit() {


  }
  volunteerLocation: Location = undefined;
  async updateCurrentLocation(useCurrentLocation: boolean) {

    this.volunteerLocation = undefined;
    if (useCurrentLocation) {
      await new Promise((res, rej) => {
        navigator.geolocation.getCurrentPosition(x => {
          this.volunteerLocation = {
            lat: x.coords.latitude,
            lng: x.coords.longitude
          };
          res();

        }, error => {
          this.dialog.exception("שליפת מיקום נכשלה", error);
          rej(error);
        });
      });

    }
  }

  async refreshRoute() {
    var useCurrentLocation = new BoolColumn(use.language.useCurrentLocationForStart);
    var strategy = new routeStrategyColumn();
    strategy.value = this.settings.routeStrategy.value;

    await this.context.openDialog(InputAreaComponent, x => x.args = {
      title: use.language.replanRoute,
      settings: {
        columnSettings: () => [
          { column: useCurrentLocation, visible: () => !this.partOfAssign && !this.partOfReview && !!navigator.geolocation },
          { column: this.familyLists.helper.preferredFinishAddress, visible: () => !this.settings.isSytemForMlt() },
          { column: strategy, visible: () => !this.familyLists.helper.preferredFinishAddress.value || this.familyLists.helper.preferredFinishAddress.value.trim().length == 0 || this.settings.isSytemForMlt() }
        ]
      },
      ok: async () => {
        await this.updateCurrentLocation(useCurrentLocation.value);
        if (this.familyLists.helper.wasChanged())
          await this.familyLists.helper.save();
        await this.familyLists.refreshRoute({
          strategyId: strategy.value.id,
          volunteerLocation: this.volunteerLocation
        });
      }
    });


  }

  @ServerFunction({ allowed: Roles.indie })
  static async assignFamilyDeliveryToIndie(deliveryIds: string[], context?: Context) {
    if (!getSettings(context).isSytemForMlt())
      throw "not allowed";
    for (const id of deliveryIds) {

      let fd = await context.for(ActiveFamilyDeliveries).findId(id);
      if (fd.courier.value == "" && fd.deliverStatus.value == DeliveryStatus.ReadyForDelivery) {//in case the delivery was already assigned to someone else
        fd.courier.value = context.user.id;
        await fd.save();
      }
    }
  }

  @ServerFunction({ allowed: Roles.indie })
  static async getDeliveriesByLocation(pivotLocation: Location, context?: Context) {
    if (!getSettings(context).isSytemForMlt())
      throw "not allowed";
    let r: selectListItem<DeliveryInList>[] = [];

    for await (const d of context.for(ActiveFamilyDeliveries).iterate({ where: f => f.deliverStatus.isEqualTo(DeliveryStatus.ReadyForDelivery).and(f.courier.isEqualTo('')) })) {
      let existing = r.find(x => x.item.familyId == d.family.value);
      if (existing) {
        existing.name += ", " + d.quantity.value + " X " + await (d.basketType.getTheValue());
        existing.item.ids.push(d.id.value);

      }
      else {
        let loc = d.getDrivingLocation();
        let dist = GetDistanceBetween(pivotLocation, loc);
        let myItem: DeliveryInList = {

          city: d.city.value,
          floor: d.floor.value,

          ids: [d.id.value],
          familyId: d.family.value,
          location: loc,
          distance: dist
        };
        let itemString: string =
          myItem.distance.toFixed(1) + use.language.km +
          (myItem.city ? ' (' + myItem.city + ')' : '') +
          (myItem.floor ? ' [' + use.language.floor + ' ' + myItem.floor + ']' : '') +
          ' : ' +
          d.quantity.value + ' x ' + await (d.basketType.getTheValue());

        r.push({
          selected: false,
          item: myItem,
          name: itemString
        });
      }
    }
    r.sort((a, b) => {
      if (a.item.familyId == b.item.familyId)
        return 0;

      if (a.item.distance == b.item.distance)
        if (a.item.familyId <= b.item.familyId)
          return (-1)
        else
          return 1;

      return (a.item.distance - b.item.distance);
    });
    r.splice(15);
    return r;
  };


  showCloseDeliveries() {
    return (this.context.user.roles.includes(Roles.indie) && this.settings.isSytemForMlt());
  }



  async assignNewDelivery() {
    await this.updateCurrentLocation(true);
    let afdList = await (HelperFamiliesComponent.getDeliveriesByLocation(this.volunteerLocation));

    await this.context.openDialog(SelectListComponent, x => {
      x.args = {
        title: use.language.closestDeliveries + ' (' + use.language.mergeFamilies + ')',
        multiSelect: true,
        onSelect: async (selectedItems) => {
          if (selectedItems.length > 0)
            this.busy.doWhileShowingBusy(async () => {
              let ids: string[] = [];
              for (const selectedItem of selectedItems) {
                let d: DeliveryInList = selectedItem.item;
                ids.push(...d.ids);
              }
              await HelperFamiliesComponent.assignFamilyDeliveryToIndie(ids);
              await this.familyLists.refreshRoute({
                strategyId: this.settings.routeStrategy.value.id,
                volunteerLocation: this.volunteerLocation
              });
              await this.familyLists.reload();
            });
        },
        options: afdList
      }
    });


  }

  getHelpText() {
    var r = this.settings.lang.ifYouNeedAnyHelpPleaseCall;
    r += " ";
    if (this.settings.helpText.value && this.settings.helpPhone.value)
      return r + this.settings.helpText.value + ", " + this.settings.helpPhone.displayValue;
    else {
      var h = this.context.for(Helpers).lookup(h => h.id.isEqualTo(this.context.user.id));
      return r + h.name.value + ", " + h.phone.displayValue;
    }
  }

  buttons: GridButton[] = [];
  prevMap: MapComponent;
  lastBounds: string;
  mapTabClicked() {
    if (this.map && this.map != this.prevMap) {
      this.familyLists.setMap(this.map);
      this.prevMap = this.map;
    }
    if (this.map) {
      if (this.tab.selectedIndex == 1 && this.lastBounds != this.map.lastBounds) {
        this.map.lastBounds = '';
        this.map.fitBounds();
      }
      this.lastBounds = this.map.lastBounds;
    }

  }
  async cancelAssign(f: ActiveFamilyDeliveries) {
    this.dialog.analytics('Cancel Assign');
    f.courier.value = '';
    await f.save();
    this.familyLists.reload();
    this.assignmentCanceled.emit();
  }
  cancelAll() {
    this.dialog.YesNoQuestion(use.language.areYouSureYouWantToCancelAssignmentTo + " " + this.familyLists.toDeliver.length + " " + use.language.families + "?", async () => {
      await this.busy.doWhileShowingBusy(async () => {

        this.dialog.analytics('cancel all');
        try {
          await HelperFamiliesComponent.cancelAssignAllForHelperOnServer(this.familyLists.helper.id.value);
        }
        catch (err) {
          await this.dialog.exception(use.language.cancelAssignmentForHelperFamilies, err);
        }
        this.familyLists.reload();
        this.assignmentCanceled.emit();
      });
    });

  }
  setDefaultCourier() {
    this.familyLists.helper.setAsDefaultVolunteerToDeliveries(this.busy, this.familyLists.toDeliver, this.dialog);
  }
  @ServerFunction({ allowed: Roles.distCenterAdmin })
  static async cancelAssignAllForHelperOnServer(id: string, context?: Context) {
    let dist = '';
    await pagedRowsIterator(context.for(ActiveFamilyDeliveries), {
      where: fd => fd.onTheWayFilter().and(fd.courier.isEqualTo(id)),
      forEachRow: async fd => {
        fd.courier.value = '';
        fd._disableMessageToUsers = true;
        dist = fd.distributionCenter.value;
        await fd.save();
      }
    });
    await Families.SendMessageToBrowsers(getLang(context).cancelAssignmentForHelperFamilies, context, dist);
  }
  distanceFromPreviousLocation(f: ActiveFamilyDeliveries, i: number) {
    if (i == 0) { return undefined; }
    if (!f.addressOk.value)
      return undefined;
    let of = this.familyLists.toDeliver[i - 1];
    if (!of.addressOk.value)
      return undefined;
    return GetDistanceBetween(of.getDrivingLocation(), f.getDrivingLocation());
    return of.addressLatitude.value == f.addressLatitude.value && of.addressLongitude.value == f.addressLongitude.value;
  }
  @ServerFunction({ allowed: Roles.distCenterAdmin })
  static async okAllForHelperOnServer(id: string, context?: Context) {
    let dist = '';
    await pagedRowsIterator(context.for(ActiveFamilyDeliveries), {
      where: fd => fd.onTheWayFilter().and(fd.courier.isEqualTo(id)),
      forEachRow: async fd => {
        dist = fd.distributionCenter.value;
        fd.deliverStatus.value = DeliveryStatus.Success;
        fd._disableMessageToUsers = true;
        await fd.save();
      }
    });
    await Families.SendMessageToBrowsers(use.language.markAllDeliveriesAsSuccesfull, context, dist);
  }
  notMLT() {
    return !this.settings.isSytemForMlt();
  }

  limitReady = new limitList(30, () => this.familyLists.toDeliver.length);
  limitDelivered = new limitList(10, () => this.familyLists.delivered.length);
  okAll() {
    this.dialog.YesNoQuestion(use.language.areYouSureYouWantToMarkDeliveredSuccesfullyToAllHelperFamilies + this.familyLists.toDeliver.length + " " + use.language.families + "?", async () => {
      await this.busy.doWhileShowingBusy(async () => {

        this.dialog.analytics('ok all');
        try {
          await HelperFamiliesComponent.okAllForHelperOnServer(this.familyLists.helper.id.value);
        }
        catch (err) {
          await this.dialog.exception(use.language.markDeliveredToAllHelprFamilies, err);
        }
        this.familyLists.reload();
      });
    });
  }
  async moveBasketsTo(to: HelpersBase) {
    await new moveDeliveriesHelper(this.context, this.settings, this.dialog, () => this.familyLists.reload()).move(this.familyLists.helper, to, true);

  }

  moveBasketsToOtherVolunteer() {
    this.context.openDialog(
      SelectHelperComponent, s => s.args = {
        filter: h => h.id.isDifferentFrom(this.familyLists.helper.id),
        hideRecent: true,
        onSelect: async to => {
          if (to) {
            this.moveBasketsTo(to);
          }
        }
      });
  }
  async refreshDependentVolunteers() {

    this.otherDependentVolunteers = [];

    this.busy.donotWaitNonAsync(async () => {
      if (this.familyLists.helper.leadHelper.value) {
        this.otherDependentVolunteers.push(await this.context.for(Helpers).lookupAsync(this.familyLists.helper.leadHelper));
      }
      this.otherDependentVolunteers.push(...await this.context.for(Helpers).find({ where: h => h.leadHelper.isEqualTo(this.familyLists.helper.id) }));
    });
  }
  otherDependentVolunteers: Helpers[] = [];

  allDoneMessage() { return ApplicationSettings.get(this.context).messageForDoneDelivery.value; };
  async deliveredToFamily(f: ActiveFamilyDeliveries) {
    this.deliveredToFamilyOk(f, DeliveryStatus.Success, s => s.commentForSuccessDelivery);
  }
  async leftThere(f: ActiveFamilyDeliveries) {
    this.deliveredToFamilyOk(f, DeliveryStatus.SuccessLeftThere, s => s.commentForSuccessLeft);
  }
  @ServerFunction({ allowed: c => c.isSignedIn() })
  static async sendSuccessMessageToFamily(deliveryId: string, context?: ServerContext) {
    var settings = getSettings(context);
    if (!settings.allowSendSuccessMessageOption.value)
      return;
    if (!settings.sendSuccessMessageToFamily.value)
      return;
    let fd = await context.for(ActiveFamilyDeliveries).findFirst(f => f.id.isEqualTo(deliveryId).and(f.visibleToCourier.isEqualTo(true)).and(f.deliverStatus.isIn([DeliveryStatus.Success, DeliveryStatus.SuccessLeftThere])));
    if (!fd)
      console.log("did not send sms to " + deliveryId + " failed to find delivery");
    if (!fd.phone1.value)
      return;
    if (!fd.phone1.value.startsWith("05"))
      return;
    let phone = PhoneColumn.fixPhoneInput(fd.phone1.value);
    if (phone.length != 10) {
      console.log(phone + " doesn't match sms structure");
      return;
    }


    await new SendSmsUtils().sendSms(phone, settings.helpPhone.value, SendSmsAction.getSuccessMessage(settings.successMessageText.value, settings.organisationName.value, fd.name.value), context.getOrigin(), Sites.getOrganizationFromContext(context), settings);
  }
  async deliveredToFamilyOk(f: ActiveFamilyDeliveries, status: DeliveryStatus, helpText: (s: ApplicationSettings) => Column) {
    this.context.openDialog(GetVolunteerFeedback, x => x.args = {
      family: f,
      comment: f.courierComments.value,
      helpText,
      ok: async (comment) => {
        if (!f.isNew()) {
          f.deliverStatus.value = status;
          f.courierComments.value = comment;
          f.checkNeedsWork();
          try {
            await f.save();
            this.dialog.analytics('delivered');
            this.initFamilies();
            if (this.familyLists.toDeliver.length == 0) {
              this.dialog.messageDialog(this.allDoneMessage());
            }
            if (this.settings.allowSendSuccessMessageOption.value && this.settings.sendSuccessMessageToFamily.value)
              HelperFamiliesComponent.sendSuccessMessageToFamily(f.id.value);

          }
          catch (err) {
            this.dialog.Error(err);
          }
        }
      },
      cancel: () => { }
    });

  }
  initFamilies() {
    this.familyLists.initFamilies();
    if (this.familyLists.toDeliver.length > 0)
      this.familyLists.toDeliver[0].distributionCenter.getRouteStartGeo().then(x => this.routeStart = x);

  }
  showLeftFamilies() {
    return this.partOfAssign || this.partOfReview || this.familyLists.toDeliver.length > 0;
  }
  async couldntDeliverToFamily(f: ActiveFamilyDeliveries) {
    let showUpdateFail = false;
    let q = this.settings.getQuestions();
    if (!q || q.length == 0) {
      showUpdateFail = true;
    } else {
      showUpdateFail = await this.context.openDialog(CommonQuestionsComponent, x => x.init(this.familyLists.allFamilies[0]), x => x.updateFailedDelivery);
    }
    if (showUpdateFail)
      this.context.openDialog(GetVolunteerFeedback, x => x.args = {
        family: f,
        comment: f.courierComments.value,
        showFailStatus: true,

        helpText: s => s.commentForProblem,

        ok: async (comment, status) => {
          if (f.isNew())
            return;
          f.deliverStatus.value = status;
          f.courierComments.value = comment;
          f.checkNeedsWork();
          try {
            await f.save();
            this.dialog.analytics('Problem');
            this.initFamilies();


          }
          catch (err) {
            this.dialog.Error(err);
          }
        },
        cancel: () => { },

      });
  }
  async sendSms(reminder: Boolean) {
    this.helperGotSms = true;
    this.dialog.analytics('Send SMS ' + (reminder ? 'reminder' : ''));
    let to = this.familyLists.helper.name.value;
    await SendSmsAction.SendSms(this.familyLists.helper.id.value, reminder);
    if (this.familyLists.helper.escort.value) {
      to += ' ול' + this.familyLists.escort.name.value;
      await SendSmsAction.SendSms(this.familyLists.helper.escort.value, reminder);
    }
    this.dialog.Info(use.language.smsMessageSentTo + " " + to);
    this.assignSmsSent.emit();
    if (reminder)
      this.familyLists.helper.reminderSmsDate.value = new Date();
  }
  async sendWhatsapp() {
    let phone = this.smsPhone;
    if (phone.startsWith('0')) {
      phone = this.settings.getInternationalPhonePrefix() + phone.substr(1);
    }
    if (phone.startsWith('+'))
      phone = phone.substr(1);
    if (isDesktop())
      window.open('https://web.whatsapp.com/send?phone=+' + phone + '&text=' + encodeURI(this.smsMessage), '_whatsapp');
    else
      window.open('https://wa.me/' + phone + '?text=' + encodeURI(this.smsMessage), '_blank');
    await this.updateMessageSent("Whatsapp");
  }
  async customSms() {
    let h = this.familyLists.helper;
    let phone = h.phone.value;
    if (phone.startsWith('0')) {
      phone = '972' + phone.substr(1);
    }
    await this.context.openDialog(GetVolunteerFeedback, x => x.args = {
      helpText: () => new StringColumn(),
      ok: async (comment) => {
        try {
          await (await import("../update-family-dialog/update-family-dialog.component")).UpdateFamilyDialogComponent.SendCustomMessageToCourier(this.familyLists.helper.id.value, comment);
          this.dialog.Info("הודעה נשלחה");
        }
        catch (err) {
          this.dialog.exception("שליחת הודעה למתנדב ", err);
        }
      },
      cancel: () => { },
      hideLocation: true,
      title: 'שלח הודעת ל' + h.name.value,
      family: undefined,
      comment: this.smsMessage
    });
  }
  smsMessage: string = '';
  smsPhone: string = '';
  smsLink: string = '';
  isReminderMessage: boolean = false;
  prepareMessage(reminder: boolean) {
    this.isReminderMessage = reminder;
    this.busy.donotWait(async () => {
      await SendSmsAction.generateMessage(this.context, this.familyLists.helper, window.origin, reminder, this.context.user.name, async (phone, message, sender, link) => {
        this.smsMessage = message;
        this.smsPhone = phone;
        this.smsLink = link;
      });
    });
  }
  async sendPhoneSms() {
    try {
      window.open('sms:' + this.smsPhone + ';?&body=' + encodeURI(this.smsMessage), '_blank');
      await this.updateMessageSent("Sms from user phone");
    } catch (err) {
      this.dialog.Error(err);
    }
  }
  async callHelper() {
    location.href = 'tel:' + this.familyLists.helper.phone.value;
    if (this.settings.isSytemForMlt()) {
      await this.context.openDialog(EditCommentDialogComponent, inputArea => inputArea.args = {
        title: 'הוסף הערה לתכתובות של המתנדב',

        save: async (comment) => {
          let hist = this.context.for((await import('../in-route-follow-up/in-route-helpers')).HelperCommunicationHistory).create();
          hist.volunteer.value = this.familyLists.helper.id.value;
          hist.comment.value = comment;
          await hist.save();
        },
        comment: 'התקשרתי'


      });
    }
  }
  callEscort() {
    window.open('tel:' + this.familyLists.escort.phone.value);
  }
  async updateMessageSent(type: string) {

    await SendSmsAction.documentHelperMessage(this.isReminderMessage, this.familyLists.helper, this.context, type);
  }
  async copyMessage() {
    copy(this.smsMessage);
    this.dialog.Info(use.language.messageCopied);
    await this.updateMessageSent("Message Copied");
  }
  async copyLink() {
    copy(this.smsLink);
    this.dialog.Info(use.language.linkCopied);
    await this.updateMessageSent("Link Copied");
  }

  updateComment(f: ActiveFamilyDeliveries) {
    this.context.openDialog(GetVolunteerFeedback, x => x.args = {
      family: f,
      comment: f.courierComments.value,
      helpText: s => s.commentForSuccessDelivery,
      ok: async comment => {
        if (f.isNew())
          return;
        f.courierComments.value = comment;
        f.checkNeedsWork();
        await f.save();
        this.dialog.analytics('Update Comment');
      }
      ,
      cancel: () => { }
    });
  }
  routeStart = this.settings.address.getGeocodeInformation();
  async showRouteOnGoogleMaps() {

    if (this.familyLists.toDeliver.length > 0) {

      let endOnDist = this.settings.routeStrategy.value.args.endOnDistributionCenter;
      let url = 'https://www.google.com/maps/dir';
      if (!endOnDist)
        if (this.volunteerLocation) {
          url += "/" + encodeURI(toLongLat(this.volunteerLocation));
        }
        else
          url += "/" + encodeURI((this.routeStart).getAddress());

      for (const f of this.familyLists.toDeliver) {
        url += '/' + encodeURI(isGpsAddress(f.address.value) ? f.address.value : f.addressByGoogle.value);
      }
      if (endOnDist)
        url += "/" + encodeURI((this.routeStart).getAddress());
      window.open(url + "?hl=" + getLang(this.context).languageCode, '_blank');
    }
    //window.open(url,'_blank');
  }
  async returnToDeliver(f: ActiveFamilyDeliveries) {
    f.deliverStatus.value = DeliveryStatus.ReadyForDelivery;
    try {
      await f.save();
      this.dialog.analytics('Return to Deliver');
      this.initFamilies();
    }
    catch (err) {
      this.dialog.Error(err);
    }
  }
  @ViewChild("map", { static: false }) map: MapComponent;

}

interface DeliveryInList {
  ids: string[],
  familyId: string,
  city: string,
  floor: string,
  location: Location,
  distance: number
}

class limitList {
  constructor(public limit: number, private relevantCount: () => number) {

  }
  _showAll = false;
  showButton() {
    return !this._showAll && this.limit < this.relevantCount();
  }
  showAll() {
    this._showAll = true;
  }
  shouldShow(i: number) {
    return this._showAll || i < this.limit;
  }
}

function isDesktop() {
  const navigatorAgent =
    //@ts-ignore
    navigator.userAgent || navigator.vendor || window.opera;
  return !(
    /(android|bb\d+|meego).+mobile|avantgo|bada\/|blackberry|blazer|compal|elaine|fennec|hiptop|iemobile|ip(hone|od)|iris|kindle|lge |maemo|midp|mmp|mobile.+firefox|netfront|opera m(ob|in)i|palm( os)?|phone|p(ixi|re)\/|plucker|pocket|psp|series([46])0|symbian|treo|up\.(browser|link)|vodafone|wap|windows ce|xda|xiino|android|ipad|playbook|silk/i.test(
      navigatorAgent
    ) ||
    /1207|6310|6590|3gso|4thp|50[1-6]i|770s|802s|a wa|abac|ac(er|oo|s-)|ai(ko|rn)|al(av|ca|co)|amoi|an(ex|ny|yw)|aptu|ar(ch|go)|as(te|us)|attw|au(di|-m|r |s )|avan|be(ck|ll|nq)|bi(lb|rd)|bl(ac|az)|br([ev])w|bumb|bw-([nu])|c55\/|capi|ccwa|cdm-|cell|chtm|cldc|cmd-|co(mp|nd)|craw|da(it|ll|ng)|dbte|dc-s|devi|dica|dmob|do([cp])o|ds(12|-d)|el(49|ai)|em(l2|ul)|er(ic|k0)|esl8|ez([4-7]0|os|wa|ze)|fetc|fly([-_])|g1 u|g560|gene|gf-5|g-mo|go(\.w|od)|gr(ad|un)|haie|hcit|hd-([mpt])|hei-|hi(pt|ta)|hp( i|ip)|hs-c|ht(c([- _agpst])|tp)|hu(aw|tc)|i-(20|go|ma)|i230|iac([ \-/])|ibro|idea|ig01|ikom|im1k|inno|ipaq|iris|ja([tv])a|jbro|jemu|jigs|kddi|keji|kgt([ /])|klon|kpt |kwc-|kyo([ck])|le(no|xi)|lg( g|\/([klu])|50|54|-[a-w])|libw|lynx|m1-w|m3ga|m50\/|ma(te|ui|xo)|mc(01|21|ca)|m-cr|me(rc|ri)|mi(o8|oa|ts)|mmef|mo(01|02|bi|de|do|t([- ov])|zz)|mt(50|p1|v )|mwbp|mywa|n10[0-2]|n20[2-3]|n30([02])|n50([025])|n7(0([01])|10)|ne(([cm])-|on|tf|wf|wg|wt)|nok([6i])|nzph|o2im|op(ti|wv)|oran|owg1|p800|pan([adt])|pdxg|pg(13|-([1-8]|c))|phil|pire|pl(ay|uc)|pn-2|po(ck|rt|se)|prox|psio|pt-g|qa-a|qc(07|12|21|32|60|-[2-7]|i-)|qtek|r380|r600|raks|rim9|ro(ve|zo)|s55\/|sa(ge|ma|mm|ms|ny|va)|sc(01|h-|oo|p-)|sdk\/|se(c([-01])|47|mc|nd|ri)|sgh-|shar|sie([-m])|sk-0|sl(45|id)|sm(al|ar|b3|it|t5)|so(ft|ny)|sp(01|h-|v-|v )|sy(01|mb)|t2(18|50)|t6(00|10|18)|ta(gt|lk)|tcl-|tdg-|tel([im])|tim-|t-mo|to(pl|sh)|ts(70|m-|m3|m5)|tx-9|up(\.b|g1|si)|utst|v400|v750|veri|vi(rg|te)|vk(40|5[0-3]|-v)|vm40|voda|vulc|vx(52|53|60|61|70|80|81|83|85|98)|w3c([- ])|webc|whit|wi(g |nc|nw)|wmlb|wonu|x700|yas-|your|zeto|zte-/i.test(
      navigatorAgent.substr(0, 4)
    )
  );
};